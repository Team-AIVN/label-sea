"""ProjectMember CRUD endpoints (role management).

Mirrors the ``workspaces.api`` membership pattern. Mutation is gated on
``is_super_admin ∨ is_project_manager_of`` so that:

- Super admins can manage any project's membership organisation-wide.
- Project managers can manage membership of projects they own.
- Workspace managers inherit PM authority via ``is_project_manager_of`` (it
  treats workspace manager as implicit PM for every project in the workspace).

Soft delete only — ``ProjectMember.deleted_at`` is stamped rather than the row
being removed, so audit / settlement history stays intact.
"""

from __future__ import annotations

from audit.models import AuditAction
from audit.services import record_role_change
from core.mixins import GetParentObjectMixin
from core.permissions import ViewClassPermission, all_permissions
from django.db import transaction
from django.utils import timezone
from django.utils.decorators import method_decorator
from drf_spectacular.utils import extend_schema
from projects.models import Project, ProjectMember
from projects.serializers import ProjectMemberSerializer
from rest_framework import generics
from rest_framework.exceptions import PermissionDenied, ValidationError
from users.rules import is_project_manager_of, is_super_admin


def _active_org_or_400(user):
    org = getattr(user, 'active_organization', None)
    if org is None:
        raise ValidationError('User has no active organization; cannot access project members.')
    return org


class _ProjectScopedMixin(GetParentObjectMixin):
    parent_queryset = Project.objects.all()
    parent_lookup_url_kwarg = 'pk'

    def _get_project(self) -> Project:
        org = _active_org_or_400(self.request.user)
        project = self.parent_object
        if project.organization_id != org.id:
            raise PermissionDenied('Project does not belong to the active organization.')
        return project

    def _require_manager(self, project: Project) -> None:
        if is_super_admin.test(self.request.user):
            return
        if is_project_manager_of.test(self.request.user, project):
            return
        raise PermissionDenied('Only project/workspace managers or super admins can manage project membership.')


@method_decorator(
    name='get',
    decorator=extend_schema(tags=['Projects'], summary='List project members'),
)
@method_decorator(
    name='post',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Add project member',
        request=ProjectMemberSerializer,
        responses={201: ProjectMemberSerializer},
    ),
)
class ProjectMembersAPI(_ProjectScopedMixin, generics.ListCreateAPIView):
    serializer_class = ProjectMemberSerializer
    permission_required = ViewClassPermission(
        GET=all_permissions.projects_view,
        POST=all_permissions.projects_change,
    )

    def get_queryset(self):
        project = self._get_project()
        return project.members.filter(deleted_at__isnull=True).select_related('user').order_by('id')

    @transaction.atomic
    def perform_create(self, serializer):
        project = self._get_project()
        self._require_manager(project)

        user = serializer.validated_data['user']
        role = serializer.validated_data.get('role') or ProjectMember._meta.get_field('role').default

        # Resurrect a soft-deleted row rather than spawning a duplicate — the
        # unique-active constraint (`uniq_active_project_member`) forbids two
        # active rows for the same (user, project), and we want the audit trail
        # chained on the original row.
        existing = ProjectMember.objects.filter(user=user, project=project).order_by('-id').first()
        if existing is not None:
            existing.role = role
            existing.deleted_at = None
            existing.deleted_by = None
            existing.enabled = True
            existing.save()
            serializer.instance = existing
            member = existing
            action = AuditAction.ROLE_GRANTED
        else:
            member = serializer.save(project=project)
            action = AuditAction.ROLE_GRANTED

        # Assigning someone to a project also makes them a member of the project's
        # workspace (low-privilege 'member'), so a manager can add people straight
        # from the project's Workers tab without a separate workspace-invite step.
        # This is a system side effect of an authorised project-member creation, so
        # it does not require the caller to hold workspace-invite permission.
        self._ensure_workspace_membership(user, project)

        record_role_change(
            action=action,
            actor=self.request.user,
            subject=member,
            scope='project',
            scope_id=project.id,
            role=member.role,
            organization=project.organization,
        )

    @staticmethod
    def _ensure_workspace_membership(user, project):
        if not project.workspace_id:
            return
        from workspaces.models import WorkspaceMember

        existing = WorkspaceMember.objects.filter(user=user, workspace_id=project.workspace_id).order_by('-id').first()
        if existing is None:
            WorkspaceMember.objects.create(user=user, workspace_id=project.workspace_id, role='member')
        elif existing.deleted_at is not None:
            # WorkspaceMember tracks only `deleted_at` — unlike ProjectMember it has no
            # `deleted_by` column, so writing one here raised ValueError (HTTP 500) whenever
            # someone removed from a workspace was assigned to one of its projects again.
            existing.deleted_at = None
            existing.role = existing.role or 'member'
            existing.save(update_fields=['deleted_at', 'role', 'updated_at'])


@method_decorator(
    name='get',
    decorator=extend_schema(tags=['Projects'], summary='Get project member'),
)
@method_decorator(
    name='patch',
    decorator=extend_schema(tags=['Projects'], summary='Update project member role'),
)
@method_decorator(
    name='delete',
    decorator=extend_schema(tags=['Projects'], summary='Remove project member'),
)
class ProjectMemberDetailAPI(_ProjectScopedMixin, generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ProjectMemberSerializer
    permission_required = ViewClassPermission(
        GET=all_permissions.projects_view,
        PATCH=all_permissions.projects_change,
        PUT=all_permissions.projects_change,
        DELETE=all_permissions.projects_change,
    )
    lookup_url_kwarg = 'member_pk'

    def get_queryset(self):
        project = self._get_project()
        return project.members.all()

    def perform_update(self, serializer):
        project = self._get_project()
        self._require_manager(project)
        previous_role = getattr(serializer.instance, 'role', None)
        member = serializer.save()
        new_role = getattr(member, 'role', None)
        if previous_role != new_role:
            record_role_change(
                action=AuditAction.ROLE_CHANGED,
                actor=self.request.user,
                subject=member,
                scope='project',
                scope_id=project.id,
                role=new_role,
                previous_role=previous_role,
                organization=project.organization,
            )

    def perform_destroy(self, instance):
        project = self._get_project()
        self._require_manager(project)
        if instance.deleted_at is not None:
            return
        record_role_change(
            action=AuditAction.ROLE_REVOKED,
            actor=self.request.user,
            subject=instance,
            scope='project',
            scope_id=project.id,
            role=getattr(instance, 'role', None),
            organization=project.organization,
        )
        instance.deleted_at = timezone.now()
        instance.deleted_by = self.request.user
        instance.enabled = False
        instance.save(update_fields=['deleted_at', 'deleted_by', 'enabled', 'updated_at'])
