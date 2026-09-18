"""This file and its contents are licensed under the Apache License 2.0. Please see the included NOTICE for copyright information and LICENSE for a copy of the license."""

import logging

from core.permissions import ViewClassPermission, all_permissions
from django.utils.decorators import method_decorator
from drf_spectacular.utils import extend_schema
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from tasks.models import Annotation, Task
from users.rules import (
    is_project_manager_of,
    is_project_member_of,
    is_reviewer_of,
    is_super_admin,
    is_workspace_manager_of,
    project_tasks,
    visible_projects,
)

from . import services
from .models import Review
from .serializers import (
    ReviewCandidateSerializer,
    ReviewProgressSerializer,
    ReviewSerializer,
    ReviewSubmitSerializer,
)

logger = logging.getLogger(__name__)


def _project_in_active_org_or_404(request, project_pk):
    org = getattr(request.user, 'active_organization', None)
    if org is None:
        raise ValidationError('User has no active organization.')
    return generics.get_object_or_404(visible_projects(request.user), pk=project_pk)


def _require_reviewer(user, project):
    if is_reviewer_of.test(user, project) or is_project_manager_of.test(user, project):
        return
    raise PermissionDenied('Reviewer or project manager role is required.')


def _is_review_manager(user, project):
    """Can see every task's review info (reviewer, project manager, WM, super admin)."""
    return (
        is_super_admin.test(user)
        or is_reviewer_of.test(user, project)
        or is_project_manager_of.test(user, project)
        or (project.workspace_id and is_workspace_manager_of.test(user, project.workspace))
    )


def _review_task_queryset(user, project, task_id=None):
    """Reviewers/managers see all tasks; a labeler sees only tasks they annotated
    (so they can review the decisions/reasons on their own work).

    Exception: a single task addressed by ``?task=<id>`` — the activity-log deep link from
    the Data Manager's status column — is visible to any project member who can open that
    task. For a labeler that means a task assigned to them (``project_tasks`` applies the
    assignment scope), even before they annotate it; tasks assigned to others stay hidden.
    """
    base = (
        Task.objects.filter(project=project)
        .select_related('current_annotation', 'current_annotation__completed_by')
        # Prefetched so the serializer resolves annotator + reviews without a per-task
        # query (avoids N+1 across the task list).
        .prefetch_related('annotations__completed_by', 'annotations__reviews__reviewer')
    )
    base = project_tasks(user, project, base)
    if _is_review_manager(user, project):
        return base
    if task_id and is_project_member_of.test(user, project):
        return base.filter(id=task_id)
    return base.filter(annotations__completed_by=user).distinct()


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Reviews'],
        summary='List review candidates',
        description='Tasks in the project whose current annotation is pending review.',
    ),
)
class ReviewCandidatesAPI(generics.ListAPIView):
    serializer_class = ReviewCandidateSerializer
    permission_required = ViewClassPermission(GET=all_permissions.projects_view)

    def get_queryset(self):
        project = _project_in_active_org_or_404(self.request, self.kwargs['pk'])
        _require_reviewer(self.request.user, project)
        return (
            Task.objects.filter(project=project, review_status=Task.ReviewStatus.PENDING)
            .select_related('current_annotation', 'current_annotation__completed_by')
            # Same serializer as ReviewTasksAPI: prefetch annotations/reviews so annotator +
            # reviews resolve without a per-task query (was 2N+1).
            .prefetch_related('annotations__completed_by', 'annotations__reviews__reviewer')
            .order_by('id')
        )


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Reviews'],
        summary='Review task list',
        description='All tasks in the project with review columns (task id, current annotation '
        'version, annotator, review status, reviewer) for the review Task List UI. '
        'Optional ?review_status= filter.',
    ),
)
class ReviewTasksAPI(generics.ListAPIView):
    serializer_class = ReviewCandidateSerializer
    permission_required = ViewClassPermission(GET=all_permissions.projects_view)

    def get_queryset(self):
        project = _project_in_active_org_or_404(self.request, self.kwargs['pk'])
        # Focus a single task (used by the Data Manager status column's activity link).
        task_id = self.request.query_params.get('task')
        qs = _review_task_queryset(self.request.user, project, task_id=task_id)
        review_status = self.request.query_params.get('review_status')
        if review_status:
            valid = {c for c, _ in Task.ReviewStatus.choices}
            if review_status not in valid:
                raise ValidationError(f'invalid review_status; one of {sorted(valid)}')
            qs = qs.filter(review_status=review_status)
        if task_id:
            qs = qs.filter(id=task_id)
        return qs.order_by('id')


@method_decorator(
    name='get',
    decorator=extend_schema(tags=['Reviews'], summary='Review progress', description='Annotation and review progress.'),
)
class ReviewProgressAPI(generics.GenericAPIView):
    serializer_class = ReviewProgressSerializer
    permission_required = ViewClassPermission(GET=all_permissions.projects_view)

    def get(self, request, *args, **kwargs):
        project = _project_in_active_org_or_404(request, self.kwargs['pk'])
        # Managers see full progress; so does anyone assigned to the project. Membership is
        # enough — a labeler who opens a teammate's task from the status column has not
        # annotated anything yet, and 403-ing them broke the activity page. Annotating
        # without a membership row still counts, as it did before.
        if not (
            _is_review_manager(request.user, project)
            or is_project_member_of.test(request.user, project)
            or Task.objects.filter(project=project, annotations__completed_by=request.user).exists()
        ):
            raise PermissionDenied('You do not have access to this project.')
        base = project_tasks(request.user, project, Task.objects.filter(project=project))
        selected = base.exclude(review_status=Task.ReviewStatus.NOT_SELECTED).count()
        completed = base.filter(
            review_status__in=[
                Task.ReviewStatus.ACCEPTED,
                Task.ReviewStatus.REJECTED,
                Task.ReviewStatus.FIXED_AND_ACCEPTED,
            ]
        ).count()
        data = {
            'annotation_progress': services.annotation_progress(project),
            'review_progress': services.review_progress(project),
            'total_tasks': base.count(),
            'review_selected': selected,
            'review_completed': completed,
        }
        return Response(ReviewProgressSerializer(data).data)


@method_decorator(
    name='post',
    decorator=extend_schema(
        tags=['Reviews'],
        summary='Submit a review decision',
        description='ACCEPT / REJECT / FIX_AND_ACCEPT a specific annotation revision. '
        'FIX_AND_ACCEPT creates a new reviewer-authored revision and approves it.',
        request=ReviewSubmitSerializer,
        responses={201: ReviewSerializer},
    ),
)
class AnnotationReviewAPI(generics.GenericAPIView):
    serializer_class = ReviewSubmitSerializer
    permission_required = ViewClassPermission(POST=all_permissions.annotations_change)

    def post(self, request, *args, **kwargs):
        annotation = generics.get_object_or_404(Annotation, pk=self.kwargs['pk'])
        project = annotation.project
        org = getattr(request.user, 'active_organization', None)
        if org is None or project.organization_id != org.id:
            raise PermissionDenied('Annotation is not in your active organization.')
        _require_reviewer(request.user, project)

        serializer = ReviewSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        if data['decision'] == Review.Decision.FIX_AND_ACCEPT and 'content' not in data:
            raise ValidationError({'content': 'content (corrected result) is required for FIX_AND_ACCEPT.'})

        task = annotation.task
        if task.current_annotation_id is None:
            # Projects without an auto-review strategy (review_strategy=NONE) never run the
            # selection signal, so the task has no current_annotation. A reviewer was still
            # explicitly assigned and is reviewing this annotation manually — adopt it as the
            # task's current revision so the workflow can proceed.
            services.assign_revision(annotation)
        elif task.current_annotation_id != annotation.id:
            raise ValidationError('Only the task current annotation revision can be reviewed.')

        review = services.review_annotation(
            annotation=annotation,
            reviewer=request.user,
            decision=data['decision'],
            comment=data.get('comment', ''),
            content=data.get('content'),
            stage=data.get('stage', 1),
        )
        return Response(ReviewSerializer(review).data, status=status.HTTP_201_CREATED)
