"""Activity timeline: submissions, labeler edits and review decisions in one list.

Mirrors the flow the status column must show:

    라벨러1 작업 후 대기
      → 라벨러2가 <필드> 수정 후 대기
      → 검수자1이 승인
"""

from core.current_request import CurrentContext
from organizations.models import OrganizationMember
from organizations.tests.factories import OrganizationFactory
from projects.models import Project, ProjectMember
from projects.tests.factories import ProjectFactory
from rest_framework.test import APITestCase
from reviews import services
from reviews.models import Review
from tasks.models import Annotation, Task
from users.constants import ProjectRole
from users.tests.factories import UserFactory

CONFIG = (
    '<View><Text name="t" value="$text"/>'
    '<Choices name="c" toName="t"><Choice value="주간"/><Choice value="석간"/></Choices></View>'
)


def _result(choice):
    return [{'from_name': 'c', 'to_name': 't', 'type': 'choices', 'value': {'choices': [choice]}}]


def _join_org(user, org):
    user.active_organization = org
    user.save(update_fields=['active_organization'])
    OrganizationMember.objects.get_or_create(user=user, organization=org)


class ActivityTimelineTests(APITestCase):
    def setUp(self):
        self.org = OrganizationFactory()
        self.owner = self.org.created_by
        _join_org(self.owner, self.org)
        self.labeler1 = UserFactory()
        self.labeler2 = UserFactory()
        self.reviewer = UserFactory()
        for user in (self.labeler1, self.labeler2, self.reviewer):
            _join_org(user, self.org)
        self.project = ProjectFactory(
            organization=self.org,
            created_by=self.owner,
            label_config=CONFIG,
            review_strategy=Project.ReviewStrategy.FULL_REVIEW,
        )
        ProjectMember.objects.create(user=self.reviewer, project=self.project, role=ProjectRole.REVIEWER)
        for user in (self.labeler1, self.labeler2):
            ProjectMember.objects.create(user=user, project=self.project, role=ProjectRole.ANNOTATOR)
        self.task = Task.objects.create(project=self.project, data={'text': 'x'})

    def tearDown(self):
        CurrentContext.set('user', None)

    def test_edit_records_who_and_what_changed(self):
        annotation = Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.labeler1,
            result=_result('주간'),
            status=Annotation.Status.COMPLETED,
        )
        assert Review.objects.filter(annotation=annotation).count() == 0

        # 라벨러2 opens 라벨러1's work and changes the choice.
        CurrentContext.set('user', self.labeler2)
        annotation.result = _result('석간')
        annotation.save()

        reviews = Review.objects.filter(annotation=annotation)
        assert reviews.count() == 1
        edit = reviews.first()
        assert edit.decision == Review.Decision.RESUBMITTED
        assert edit.reviewer_id == self.labeler2.id  # "who did it", not a reviewer
        assert edit.comment.startswith('[수정]')
        assert '주간 → 석간' in edit.comment

    def test_metadata_only_save_records_nothing(self):
        """One submit saves the annotation twice; an unchanged result must not log a row."""
        annotation = Annotation.objects.create(
            task=self.task, project=self.project, completed_by=self.labeler1, result=_result('주간')
        )
        CurrentContext.set('user', self.labeler1)
        annotation.save()  # same result
        assert Review.objects.filter(annotation=annotation).count() == 0

    def test_edit_after_approval_returns_task_to_pending(self):
        annotation = Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.labeler1,
            result=_result('주간'),
            status=Annotation.Status.COMPLETED,
        )
        services.accept(annotation, self.reviewer)
        annotation.refresh_from_db()
        assert annotation.status == Annotation.Status.APPROVED

        CurrentContext.set('user', self.labeler2)
        annotation.result = _result('석간')
        annotation.save()

        annotation.refresh_from_db()
        self.task.refresh_from_db()
        assert annotation.status == Annotation.Status.COMPLETED
        assert self.task.review_status == Task.ReviewStatus.PENDING
        # accept + edit both logged
        assert list(
            Review.objects.filter(annotation=annotation).order_by('created_at', 'id').values_list('decision', flat=True)
        ) == [Review.Decision.ACCEPT, Review.Decision.RESUBMITTED]

    def test_timeline_reads_submit_then_edit_then_accept(self):
        """The whole story, in order, as the status column will render it."""
        annotation = Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.labeler1,
            result=_result('주간'),
            status=Annotation.Status.COMPLETED,
        )
        CurrentContext.set('user', self.labeler2)
        annotation.result = _result('석간')
        annotation.save()
        CurrentContext.set('user', None)
        services.accept(annotation, self.reviewer)

        from reviews.serializers import ReviewCandidateSerializer

        task = Task.objects.prefetch_related('annotations__reviews').get(pk=self.task.pk)
        task.current_annotation_id = annotation.id
        entries = ReviewCandidateSerializer().get_reviews(task)
        entries.reverse()  # serializer is newest-first; read the story oldest-first

        assert [e['decision'] for e in entries] == ['SUBMITTED', 'RESUBMITTED', 'ACCEPT']
        assert entries[0]['reviewer']['id'] == self.labeler1.id  # 라벨러1 제출
        assert entries[1]['reviewer']['id'] == self.labeler2.id  # 라벨러2 수정
        assert '주간 → 석간' in entries[1]['comment']
        assert entries[2]['reviewer']['id'] == self.reviewer.id  # 검수자1 승인

    def test_labeler_cannot_open_activity_of_a_task_assigned_to_someone_else(self):
        """Labelers only reach tasks assigned to them, deep link included."""
        Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.labeler1,
            result=_result('주간'),
            status=Annotation.Status.COMPLETED,
        )
        Task.objects.filter(pk=self.task.pk).update(assignee=self.labeler1)
        self.client.force_authenticate(self.labeler2)

        tasks = self.client.get(f'/api/projects/{self.project.pk}/review/tasks?task={self.task.pk}')
        assert tasks.status_code == 200
        rows = tasks.json()
        rows = rows.get('results', rows) if isinstance(rows, dict) else rows
        assert rows == []

    def test_labeler_can_open_activity_of_a_task_assigned_to_them(self):
        """The status column's activity link must work for your task before you annotate it."""
        Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.labeler1,
            result=_result('주간'),
            status=Annotation.Status.COMPLETED,
        )
        # The task was reassigned to 라벨러2, who has annotated nothing here yet.
        Task.objects.filter(pk=self.task.pk).update(assignee=self.labeler2)
        self.client.force_authenticate(self.labeler2)

        progress = self.client.get(f'/api/projects/{self.project.pk}/review/progress')
        assert progress.status_code == 200

        tasks = self.client.get(f'/api/projects/{self.project.pk}/review/tasks?task={self.task.pk}')
        assert tasks.status_code == 200
        rows = tasks.json()
        rows = rows.get('results', rows) if isinstance(rows, dict) else rows
        assert len(rows) == 1
        assert [e['decision'] for e in rows[0]['reviews']] == ['SUBMITTED']

    def test_labeler_still_sees_only_own_tasks_without_deep_link(self):
        """Widening is scoped to the ?task= deep link — the project-wide list is unchanged."""
        Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.labeler1,
            result=_result('주간'),
            status=Annotation.Status.COMPLETED,
        )
        self.client.force_authenticate(self.labeler2)
        tasks = self.client.get(f'/api/projects/{self.project.pk}/review/tasks')
        rows = tasks.json()
        rows = rows.get('results', rows) if isinstance(rows, dict) else rows
        assert rows == []

    def test_non_member_is_still_denied(self):
        """A user in the org but not on the project cannot read its activity."""
        outsider = UserFactory()
        _join_org(outsider, self.org)
        Annotation.objects.create(
            task=self.task, project=self.project, completed_by=self.labeler1, result=_result('주간')
        )
        self.client.force_authenticate(outsider)

        assert self.client.get(f'/api/projects/{self.project.pk}/review/progress').status_code == 404
        tasks = self.client.get(f'/api/projects/{self.project.pk}/review/tasks?task={self.task.pk}')
        assert tasks.status_code == 404

    def test_labeler_edit_does_not_fill_reviewed_by_columns(self):
        """A labeler's edit is an activity entry, not a review — the DM's 검수자/검수됨 stay empty."""
        from data_manager.managers import annotate_reviewed_at, annotate_reviewed_by

        def dm_row():
            qs = annotate_reviewed_by(annotate_reviewed_at(Task.objects.filter(pk=self.task.pk)))
            return qs.values('reviewed_by', 'reviewed_at').first()

        annotation = Annotation.objects.create(
            task=self.task,
            project=self.project,
            completed_by=self.labeler1,
            result=_result('주간'),
            status=Annotation.Status.COMPLETED,
        )
        CurrentContext.set('user', self.labeler2)
        annotation.result = _result('석간')
        annotation.save()
        CurrentContext.set('user', None)

        row = dm_row()
        assert row['reviewed_by'] is None, f'labeler edit leaked into 검수자: {row}'
        assert row['reviewed_at'] is None

        # A real review decision does fill them.
        services.accept(annotation, self.reviewer)
        row = dm_row()
        assert row['reviewed_by'] == self.reviewer.id
        assert row['reviewed_at'] is not None

        # ...and a later labeler edit must not overwrite the reviewer with themselves.
        CurrentContext.set('user', self.labeler2)
        annotation.result = _result('주간')
        annotation.save()
        assert dm_row()['reviewed_by'] == self.reviewer.id

    def test_submitted_entry_is_derived_for_old_annotations(self):
        """No stored row for the submission, so pre-existing annotations still show it."""
        Annotation.objects.create(
            task=self.task, project=self.project, completed_by=self.labeler1, result=_result('주간')
        )
        assert Review.objects.count() == 0

        from reviews.serializers import ReviewCandidateSerializer

        task = Task.objects.prefetch_related('annotations__reviews').get(pk=self.task.pk)
        entries = ReviewCandidateSerializer().get_reviews(task)
        assert [e['decision'] for e in entries] == ['SUBMITTED']
