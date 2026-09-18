"""Tests for the project membership API, focused on the workspace side effect.

Assigning someone to a project also makes them a member of the project's workspace, so a
manager can staff a project from its Workers tab without a separate workspace invite.
"""

from organizations.models import OrganizationMember
from organizations.tests.factories import OrganizationFactory
from projects.tests.factories import ProjectFactory
from rest_framework.test import APITestCase
from users.tests.factories import UserFactory
from workspaces.models import Workspace, WorkspaceMember


def _join_org(user, org):
    user.active_organization = org
    user.save(update_fields=['active_organization'])
    OrganizationMember.objects.get_or_create(user=user, organization=org)


class ProjectMemberWorkspaceMembershipTests(APITestCase):
    def setUp(self):
        self.org = OrganizationFactory()
        self.owner = self.org.created_by  # org creator == super admin
        _join_org(self.owner, self.org)

        self.workspace = Workspace.objects.create(organization=self.org, title='WS', created_by=self.owner)
        self.project = ProjectFactory(organization=self.org, workspace=self.workspace, created_by=self.owner)

        self.worker = UserFactory()
        _join_org(self.worker, self.org)

        self.client.force_authenticate(user=self.owner)

    def _url(self, member_pk=None):
        base = f'/api/projects/{self.project.id}/members/'
        return base if member_pk is None else f'{base}{member_pk}/'

    def _add_worker(self, role='annotator'):
        return self.client.post(self._url(), {'user': self.worker.id, 'role': role}, format='json')

    def test_adding_project_member_creates_workspace_membership(self):
        response = self._add_worker()

        assert response.status_code == 201, response.content
        membership = WorkspaceMember.objects.get(workspace=self.workspace, user=self.worker)
        assert membership.role == WorkspaceMember.Role.MEMBER
        assert membership.deleted_at is None

    def test_reassign_after_workspace_membership_was_removed(self):
        """Removing someone from the workspace must not block assigning them again.

        The revive path used to also write `deleted_by`, a column WorkspaceMember doesn't
        have (ProjectMember does) — Django raised ValueError and the request 500'd.
        """
        first = self._add_worker()
        assert first.status_code == 201, first.content
        self.client.delete(self._url(first.json()['id']))

        # Manager removes them from the workspace as well (soft delete).
        membership = WorkspaceMember.objects.get(workspace=self.workspace, user=self.worker)
        removed = self.client.delete(f'/api/workspaces/{self.workspace.id}/members/{membership.id}/')
        assert removed.status_code == 204, removed.content

        again = self._add_worker(role='reviewer')

        assert again.status_code == 201, again.content
        membership.refresh_from_db()
        assert membership.deleted_at is None, 'workspace membership should be revived'
        assert (
            WorkspaceMember.objects.filter(workspace=self.workspace, user=self.worker).count() == 1
        ), 'revive must reuse the existing row, not create a duplicate'

    def test_revived_membership_keeps_its_previous_role(self):
        """A workspace manager who is re-added to a project stays a manager."""
        membership = WorkspaceMember.objects.create(
            workspace=self.workspace,
            user=self.worker,
            role=WorkspaceMember.Role.WORKSPACE_MANAGER,
        )
        removed = self.client.delete(f'/api/workspaces/{self.workspace.id}/members/{membership.id}/')
        assert removed.status_code == 204, removed.content

        assert self._add_worker().status_code == 201

        membership.refresh_from_db()
        assert membership.deleted_at is None
        assert membership.role == WorkspaceMember.Role.WORKSPACE_MANAGER
