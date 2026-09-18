from audit.models import AuditAction, AuditLog
from organizations.models import OrganizationMember
from organizations.tests.factories import OrganizationFactory
from projects.models import ProjectMember
from projects.tests.factories import ProjectFactory
from rest_framework.test import APITestCase
from users.constants import ProjectRole
from users.tests.factories import UserFactory


def _join(user, organization):
    user.active_organization = organization
    user.save(update_fields=['active_organization'])
    OrganizationMember.objects.get_or_create(user=user, organization=organization)


class ProjectMembersAPITests(APITestCase):
    def setUp(self):
        self.organization = OrganizationFactory()
        self.owner = self.organization.created_by
        _join(self.owner, self.organization)
        self.project = ProjectFactory(organization=self.organization, created_by=self.owner)
        self.worker = UserFactory()
        _join(self.worker, self.organization)
        self.client.force_authenticate(self.owner)
        self.url = f'/api/projects/{self.project.id}/members/'

    def _assign(self, role):
        return self.client.post(self.url, {'user': self.worker.id, 'role': role}, format='json')

    def test_assigning_an_existing_member_again_is_rejected(self):
        first = self._assign(ProjectRole.ANNOTATOR)
        assert first.status_code == 201, first.content

        again = self._assign(ProjectRole.REVIEWER)
        assert again.status_code == 400, again.content

        member = ProjectMember.objects.get(project=self.project, user=self.worker, deleted_at__isnull=True)
        assert member.role == ProjectRole.ANNOTATOR
        assert AuditLog.objects.filter(action=AuditAction.ROLE_GRANTED, target_id=member.id).count() == 1

    def test_role_change_goes_through_patch_and_is_audited_as_a_change(self):
        member_id = self._assign(ProjectRole.ANNOTATOR).json()['id']

        response = self.client.patch(f'{self.url}{member_id}/', {'role': ProjectRole.REVIEWER}, format='json')
        assert response.status_code == 200, response.content
        assert ProjectMember.objects.get(pk=member_id).role == ProjectRole.REVIEWER
        assert AuditLog.objects.latest('id').action == AuditAction.ROLE_CHANGED

    def test_patch_cannot_move_a_membership_to_another_user(self):
        member_id = self._assign(ProjectRole.ANNOTATOR).json()['id']
        other = UserFactory()
        _join(other, self.organization)

        response = self.client.patch(f'{self.url}{member_id}/', {'user': other.id}, format='json')
        assert response.status_code == 400, response.content
        assert ProjectMember.objects.get(pk=member_id).user_id == self.worker.id

    def test_removed_member_can_be_assigned_again(self):
        member_id = self._assign(ProjectRole.ANNOTATOR).json()['id']
        assert self.client.delete(f'{self.url}{member_id}/').status_code == 204

        again = self._assign(ProjectRole.REVIEWER)
        assert again.status_code == 201, again.content
        assert again.json()['id'] == member_id
        active = ProjectMember.objects.filter(project=self.project, user=self.worker, deleted_at__isnull=True)
        assert list(active.values_list('role', flat=True)) == [ProjectRole.REVIEWER]
