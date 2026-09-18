import importlib
from unittest.mock import patch

from django.apps import apps
from ml.models import MLBackend
from organizations.models import OrganizationMember
from organizations.tests.factories import OrganizationFactory
from projects.models import Project, ProjectMember
from projects.tests.factories import ProjectFactory
from rest_framework.response import Response
from rest_framework.test import APITestCase
from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from users.constants import ProjectRole
from users.tests.factories import UserFactory
from workspaces.models import WorkspaceMember
from workspaces.tests.factories import WorkspaceFactory


def _join(user, organization):
    user.active_organization = organization
    user.save(update_fields=['active_organization'])
    OrganizationMember.objects.get_or_create(user=user, organization=organization)


class ProjectAssignmentAPITests(APITestCase):
    def setUp(self):
        self.organization = OrganizationFactory()
        self.owner = self.organization.created_by
        _join(self.owner, self.organization)
        self.project = ProjectFactory(organization=self.organization, created_by=self.owner)

        self.manager = UserFactory()
        self.annotator_a = UserFactory()
        self.annotator_b = UserFactory()
        self.reviewer = UserFactory()
        self.outsider = UserFactory()
        for user in [self.manager, self.annotator_a, self.annotator_b, self.reviewer, self.outsider]:
            _join(user, self.organization)

        ProjectMember.objects.create(project=self.project, user=self.manager, role=ProjectRole.PROJECT_MANAGER)
        ProjectMember.objects.create(project=self.project, user=self.annotator_a, role=ProjectRole.ANNOTATOR)
        ProjectMember.objects.create(project=self.project, user=self.annotator_b, role=ProjectRole.ANNOTATOR)
        ProjectMember.objects.create(project=self.project, user=self.reviewer, role=ProjectRole.REVIEWER)

        self.task_a = Task.objects.create(project=self.project, data={'text': 'a'}, assignee=self.annotator_a)
        self.task_b = Task.objects.create(project=self.project, data={'text': 'b'}, assignee=self.annotator_b)
        self.unassigned = Task.objects.create(project=self.project, data={'text': 'unassigned'})
        self.all_task_ids = {self.task_a.id, self.task_b.id, self.unassigned.id}

    def _task_ids(self, user):
        self.client.force_authenticate(user)
        response = self.client.get(f'/api/tasks/?project={self.project.id}')
        assert response.status_code == 200, response.content
        return {task['id'] for task in response.json()['tasks']}

    def _act(self, user, action_id, task_ids, **body):
        self.client.force_authenticate(user)
        return self.client.post(
            f'/api/dm/actions/?id={action_id}&project={self.project.id}',
            {'selectedItems': {'all': False, 'included': task_ids}, **body},
            format='json',
        )

    # --- visibility ---

    def test_labelers_see_only_their_assigned_tasks(self):
        assert self._task_ids(self.annotator_a) == {self.task_a.id}
        assert self._task_ids(self.annotator_b) == {self.task_b.id}

    def test_managers_and_reviewers_see_every_task(self):
        for user in [self.owner, self.manager, self.reviewer]:
            assert self._task_ids(user) == self.all_task_ids

    def test_labeler_cannot_open_or_work_on_other_tasks(self):
        self.client.force_authenticate(self.annotator_a)
        assert self.client.get(f'/api/tasks/{self.task_a.id}/').status_code == 200
        for task in [self.task_b, self.unassigned]:
            assert self.client.get(f'/api/tasks/{task.id}/').status_code == 404
            response = self.client.post(f'/api/tasks/{task.id}/drafts', {'result': []}, format='json')
            assert response.status_code == 404, response.content
            response = self.client.post(f'/api/tasks/{task.id}/annotations/', {'result': []}, format='json')
            assert response.status_code == 404, response.content
        assert not AnnotationDraft.objects.filter(user=self.annotator_a).exists()
        assert not Annotation.objects.filter(completed_by=self.annotator_a).exists()

    def test_labeler_without_assignments_sees_project_but_no_tasks(self):
        from users.rules import visible_projects

        project = ProjectFactory(organization=self.organization, created_by=self.owner)
        ProjectMember.objects.create(project=project, user=self.annotator_a, role=ProjectRole.ANNOTATOR)
        Task.objects.create(project=project, data={'text': 'not assigned yet'})
        assert visible_projects(self.annotator_a).filter(pk=project.pk).exists()
        self.client.force_authenticate(self.annotator_a)
        response = self.client.get(f'/api/tasks/?project={project.id}')
        assert response.status_code == 200, response.content
        assert response.json()['tasks'] == []

    def test_workspace_manager_with_labeler_role_keeps_full_access(self):
        workspace = WorkspaceFactory(organization=self.organization)
        Project.objects.filter(pk=self.project.pk).update(workspace=workspace)
        WorkspaceMember.objects.create(user=self.annotator_b, workspace=workspace, role='workspace_manager')
        assert self._task_ids(self.annotator_b) == self.all_task_ids

    def test_non_member_cannot_reach_project_or_tasks(self):
        self.client.force_authenticate(self.outsider)
        assert self.client.get(f'/api/projects/{self.project.id}/').status_code == 404
        assert self.client.get(f'/api/tasks/?project={self.project.id}').status_code == 404
        assert self.client.get(f'/api/tasks/{self.task_a.id}/').status_code == 404
        response = self.client.post(f'/api/tasks/{self.task_a.id}/drafts', {'result': []}, format='json')
        assert response.status_code == 404

    def test_other_organization_is_excluded_even_with_membership(self):
        from users.rules import visible_projects, visible_tasks

        project = ProjectFactory()
        ProjectMember.objects.create(project=project, user=self.annotator_a, role=ProjectRole.ANNOTATOR)
        task = Task.objects.create(project=project, data={'text': 'other organization'}, assignee=self.annotator_a)
        assert not visible_projects(self.annotator_a).filter(pk=project.pk).exists()
        assert not visible_tasks(self.annotator_a).filter(pk=task.pk).exists()

    def test_deleted_membership_removes_access(self):
        from django.utils import timezone
        from users.rules import visible_tasks

        ProjectMember.objects.filter(project=self.project, user=self.annotator_a).update(deleted_at=timezone.now())
        assert not visible_tasks(self.annotator_a).filter(project=self.project).exists()

    def test_project_state_counts_only_visible_tasks(self):
        self.client.force_authenticate(self.annotator_a)
        response = self.client.get(f'/api/dm/project?project={self.project.id}')
        assert response.status_code == 200, response.content
        assert response.json()['task_count'] == 1

        self.client.force_authenticate(self.manager)
        response = self.client.get(f'/api/dm/project?project={self.project.id}')
        assert response.json()['task_count'] == 3

    def test_next_task_serves_only_assigned_tasks(self):
        self.client.force_authenticate(self.annotator_a)
        with patch('io_storages.proxy_api.ResolveStorageUriAPIMixin.resolve', return_value=Response(status=200)):
            response = self.client.get(f'/api/projects/{self.project.id}/next/')
            assert response.status_code == 200, response.content
            assert response.json()['id'] == self.task_a.id
            assert self.client.get(f'/tasks/{self.task_a.id}/resolve/?fileuri=local-test').status_code == 200
            assert self.client.get(f'/tasks/{self.task_b.id}/resolve/?fileuri=local-test').status_code == 404

        Annotation.objects.create(task=self.task_a, project=self.project, completed_by=self.annotator_a, result=[])
        assert self.client.get(f'/api/projects/{self.project.id}/next/').status_code == 404

    def test_project_storage_resolver_rejects_only_assignment_scoped_labelers(self):
        with patch('io_storages.proxy_api.ResolveStorageUriAPIMixin.resolve', return_value=Response(status=200)):
            self.client.force_authenticate(self.annotator_a)
            response = self.client.get(f'/projects/{self.project.id}/resolve/?fileuri=local-test')
            assert response.status_code == 403, response.content

            for user in [self.manager, self.reviewer]:
                self.client.force_authenticate(user)
                response = self.client.get(f'/projects/{self.project.id}/resolve/?fileuri=local-test')
                assert response.status_code == 200, response.content

    def test_only_managers_can_delete_every_project_task(self):
        url = f'/api/projects/{self.project.id}/tasks/'
        for user in [self.annotator_a, self.reviewer]:
            self.client.force_authenticate(user)
            response = self.client.delete(url)
            assert response.status_code == 403, response.content
            assert set(Task.objects.filter(project=self.project).values_list('id', flat=True)) == self.all_task_ids

        self.client.force_authenticate(self.manager)
        response = self.client.delete(url)
        assert response.status_code == 204, response.content
        assert not Task.objects.filter(project=self.project).exists()

    def test_child_resources_cannot_be_moved_to_another_task(self):
        annotation = Annotation.objects.create(
            task=self.task_a, project=self.project, completed_by=self.annotator_a, result=[]
        )
        other_annotation = Annotation.objects.create(
            task=self.task_b, project=self.project, completed_by=self.annotator_b, result=[]
        )
        draft = AnnotationDraft.objects.create(task=self.task_a, user=self.annotator_a, result=[])
        prediction = Prediction.objects.create(task=self.task_a, project=self.project, result=[])

        self.client.force_authenticate(self.annotator_a)
        response = self.client.post(
            f'/api/tasks/{self.task_a.id}/annotations/{other_annotation.id}/drafts', {'result': []}, format='json'
        )
        assert response.status_code == 404, response.content

        for url, instance in [
            (f'/api/annotations/{annotation.id}/', annotation),
            (f'/api/drafts/{draft.id}/', draft),
            (f'/api/predictions/{prediction.id}/', prediction),
        ]:
            response = self.client.patch(url, {'task': self.task_b.id}, format='json')
            assert response.status_code == 400, response.content
            instance.refresh_from_db()
            assert instance.task_id == self.task_a.id

    def test_interactive_ml_serves_only_assigned_tasks(self):
        ml_backend = MLBackend.objects.create(project=self.project, url='http://localhost:8999', is_interactive=True)
        url = f'/api/ml/{ml_backend.id}/interactive-annotating'
        self.client.force_authenticate(self.annotator_a)
        with patch.object(MLBackend, 'interactive_annotating', return_value={'data': {}}) as interactive:
            for task in [self.task_b, self.unassigned]:
                response = self.client.post(url, {'task': task.id, 'context': {}}, format='json')
                assert response.status_code == 404, response.content
            interactive.assert_not_called()

            response = self.client.post(url, {'task': self.task_a.id, 'context': {}}, format='json')
            assert response.status_code == 200, response.content
            interactive.assert_called_once()

    # --- assignment actions ---

    def test_manager_assigns_unassigned_tasks(self):
        response = self._act(self.manager, 'assign_tasks', [self.unassigned.id], labeler=str(self.annotator_b.id))
        assert response.status_code == 200, response.content
        assert response.json()['processed_items'] == 1

        self.unassigned.refresh_from_db()
        assert self.unassigned.assignee_id == self.annotator_b.id
        assert self.unassigned.assigned_by_id == self.manager.id
        assert self.unassigned.assigned_at is not None
        assert self._task_ids(self.annotator_b) == {self.task_b.id, self.unassigned.id}

        self.client.force_authenticate(self.manager)
        response = self.client.get(f'/api/tasks/{self.unassigned.id}/')
        assert response.json()['labeler'] == [self.annotator_b.id]

    def test_assigning_a_task_that_has_another_labeler_is_rejected(self):
        response = self._act(
            self.manager, 'assign_tasks', [self.unassigned.id, self.task_a.id], labeler=str(self.annotator_b.id)
        )
        assert response.status_code == 400, response.content

        # Nothing is applied when any selected task belongs to someone else.
        self.task_a.refresh_from_db()
        self.unassigned.refresh_from_db()
        assert self.task_a.assignee_id == self.annotator_a.id
        assert self.unassigned.assignee_id is None

        # Reassigning works once the task is unassigned first.
        assert self._act(self.manager, 'unassign_tasks', [self.task_a.id]).status_code == 200
        response = self._act(self.manager, 'assign_tasks', [self.task_a.id], labeler=str(self.annotator_b.id))
        assert response.status_code == 200, response.content
        self.task_a.refresh_from_db()
        assert self.task_a.assignee_id == self.annotator_b.id

    def test_assigning_the_same_labeler_again_changes_nothing(self):
        assigned_at = Task.objects.get(pk=self.task_a.pk).assigned_at
        response = self._act(self.manager, 'assign_tasks', [self.task_a.id], labeler=str(self.annotator_a.id))
        assert response.status_code == 200, response.content
        assert response.json()['processed_items'] == 0

        self.task_a.refresh_from_db()
        assert self.task_a.assignee_id == self.annotator_a.id
        assert self.task_a.assigned_at == assigned_at

    def test_only_active_labelers_can_be_assigned(self):
        for user in [self.reviewer, self.manager, self.outsider]:
            response = self._act(self.manager, 'assign_tasks', [self.unassigned.id], labeler=str(user.id))
            assert response.status_code == 400, response.content
        response = self._act(self.manager, 'assign_tasks', [self.unassigned.id])
        assert response.status_code == 400, response.content

        self.unassigned.refresh_from_db()
        assert self.unassigned.assignee_id is None

    def test_assign_form_field_matches_what_the_action_reads(self):
        self.client.force_authenticate(self.manager)
        response = self.client.get(f'/api/dm/actions/assign_tasks/form/?project={self.project.id}')
        assert response.status_code == 200, response.content
        field = response.json()[0]['fields'][0]
        assert field['name'] == 'labeler'
        options = {option['value'] for option in field['options']}
        assert options == {str(self.annotator_a.id), str(self.annotator_b.id)}

        # Submit exactly what the dialog sends: {<form field name>: <selected option value>}.
        body = {field['name']: str(self.annotator_b.id)}
        response = self._act(self.manager, 'assign_tasks', [self.unassigned.id], **body)
        assert response.status_code == 200, response.content
        self.unassigned.refresh_from_db()
        assert self.unassigned.assignee_id == self.annotator_b.id

    def test_unassign_hides_tasks_from_labeler(self):
        response = self._act(self.manager, 'unassign_tasks', [self.task_a.id])
        assert response.status_code == 200, response.content

        self.task_a.refresh_from_db()
        assert self.task_a.assignee_id is None
        assert self.task_a.assigned_by_id is None
        assert self._task_ids(self.annotator_a) == set()

    def test_assignment_actions_are_for_managers_only(self):
        for user, allowed in [(self.owner, True), (self.manager, True), (self.annotator_a, False), (self.reviewer, False)]:
            self.client.force_authenticate(user)
            response = self.client.get(f'/api/dm/actions/?project={self.project.id}')
            assert response.status_code == 200, response.content
            action_ids = {action['id'] for action in response.json()}
            assert ('assign_tasks' in action_ids) is allowed
            assert ('unassign_tasks' in action_ids) is allowed

        response = self._act(self.annotator_a, 'assign_tasks', [self.task_a.id], labeler=str(self.annotator_a.id))
        assert response.status_code == 403, response.content
        response = self._act(self.reviewer, 'unassign_tasks', [self.task_b.id])
        assert response.status_code == 403, response.content
        self.task_b.refresh_from_db()
        assert self.task_b.assignee_id == self.annotator_b.id

    # --- membership changes ---

    def test_changing_role_or_removing_labeler_releases_assignments(self):
        self.client.force_authenticate(self.manager)
        member_a = ProjectMember.objects.get(project=self.project, user=self.annotator_a)
        response = self.client.patch(
            f'/api/projects/{self.project.id}/members/{member_a.id}/', {'role': ProjectRole.REVIEWER}, format='json'
        )
        assert response.status_code == 200, response.content
        self.task_a.refresh_from_db()
        assert self.task_a.assignee_id is None

        member_b = ProjectMember.objects.get(project=self.project, user=self.annotator_b)
        response = self.client.delete(f'/api/projects/{self.project.id}/members/{member_b.id}/')
        assert response.status_code == 204, response.content
        self.task_b.refresh_from_db()
        assert self.task_b.assignee_id is None


class TaskAssignmentBackfillTests(APITestCase):
    def setUp(self):
        organization = OrganizationFactory()
        self.owner = organization.created_by
        _join(self.owner, organization)
        self.project = ProjectFactory(organization=organization, created_by=self.owner)
        self.eligible = UserFactory()
        self.inactive = UserFactory(is_active=False)
        self.reviewer = UserFactory()
        for user in [self.eligible, self.inactive, self.reviewer]:
            _join(user, organization)
        ProjectMember.objects.create(project=self.project, user=self.eligible, role=ProjectRole.ANNOTATOR)
        ProjectMember.objects.create(project=self.project, user=self.inactive, role=ProjectRole.ANNOTATOR)
        ProjectMember.objects.create(project=self.project, user=self.reviewer, role=ProjectRole.REVIEWER)

    def _task(self, text):
        return Task.objects.create(project=self.project, data={'text': text})

    def _annotate(self, task, user):
        return Annotation.objects.create(task=task, project=self.project, completed_by=user, result=[])

    def _backfill(self, *tasks):
        migration = importlib.import_module('tasks.migrations.0064_backfill_task_assignee')
        migration.backfill_task_assignee(apps, None)
        for task in tasks:
            task.refresh_from_db()

    def test_backfill_uses_latest_eligible_annotator_and_leaves_ineligible_users_unassigned(self):
        fallback_task = self._task('fallback')
        self._annotate(fallback_task, self.owner)
        latest = self._annotate(fallback_task, self.eligible)
        Task.objects.filter(id=fallback_task.id).update(current_annotation=None)

        inactive_task = self._task('inactive')
        self._annotate(inactive_task, self.inactive)
        reviewer_task = self._task('reviewer')
        self._annotate(reviewer_task, self.reviewer)

        self._backfill(fallback_task, inactive_task, reviewer_task)
        assert fallback_task.assignee_id == self.eligible.id
        assert fallback_task.current_annotation_id is None
        assert latest.completed_by_id == self.eligible.id
        assert inactive_task.assignee_id is None
        assert reviewer_task.assignee_id is None

    def test_backfill_skips_ineligible_current_author_and_covers_drafts(self):
        # The current annotation is a reviewer's: fall back to the labeler's earlier annotation.
        reviewed_task = self._task('reviewed')
        self._annotate(reviewed_task, self.eligible)
        current = self._annotate(reviewed_task, self.reviewer)
        Task.objects.filter(id=reviewed_task.id).update(current_annotation=current)

        # Work in progress: only a postponed draft exists.
        draft_task = self._task('draft')
        AnnotationDraft.objects.create(task=draft_task, user=self.eligible, result=[], was_postponed=True)

        # A submitted annotation outranks a draft by someone else.
        mixed_task = self._task('mixed')
        other = UserFactory()
        ProjectMember.objects.create(project=self.project, user=other, role=ProjectRole.ANNOTATOR)
        AnnotationDraft.objects.create(task=mixed_task, user=other, result=[])
        self._annotate(mixed_task, self.eligible)

        self._backfill(reviewed_task, draft_task, mixed_task)
        assert reviewed_task.assignee_id == self.eligible.id
        assert draft_task.assignee_id == self.eligible.id
        assert mixed_task.assignee_id == self.eligible.id
