"""This file and its contents are licensed under the Apache License 2.0. Please see the included NOTICE for copyright information and LICENSE for a copy of the license."""

from django.utils import timezone
from organizations.models import OrganizationMember
from organizations.tests.factories import OrganizationFactory
from projects.tests.factories import ProjectFactory
from rest_framework.test import APITestCase
from users.tests.factories import UserFactory
from workspaces.models import Workspace, WorkspaceMember

from .factories import WorkspaceFactory


def _results(response):
    """List endpoints return a bare array unless pagination is configured."""
    payload = response.json()
    return payload['results'] if isinstance(payload, dict) and 'results' in payload else payload


def _join_org(user, org):
    user.active_organization = org
    user.save(update_fields=['active_organization'])
    OrganizationMember.objects.get_or_create(user=user, organization=org)


class WorkspaceListAPITests(APITestCase):
    def setUp(self):
        self.organization = OrganizationFactory()
        self.owner = self.organization.created_by

    def test_create_workspace_auto_adds_creator_as_manager(self):
        self.client.force_authenticate(user=self.owner)

        response = self.client.post(
            '/api/workspaces/',
            {'title': 'Alpha workspace', 'description': 'desc'},
            format='json',
        )
        assert response.status_code == 201, response.content
        body = response.json()
        assert body['title'] == 'Alpha workspace'
        assert body['organization'] == self.organization.id

        workspace = Workspace.objects.get(pk=body['id'])
        assert workspace.created_by_id == self.owner.id

        membership = WorkspaceMember.objects.get(workspace=workspace, user=self.owner)
        assert membership.role == WorkspaceMember.Role.WORKSPACE_MANAGER

    def test_list_is_scoped_to_active_organization(self):
        other_org = OrganizationFactory()
        WorkspaceFactory(organization=self.organization, title='mine')
        WorkspaceFactory(organization=other_org, title='not-mine')

        self.client.force_authenticate(user=self.owner)
        response = self.client.get('/api/workspaces/')

        assert response.status_code == 200
        payload = response.json()
        results = payload['results'] if isinstance(payload, dict) and 'results' in payload else payload
        titles = {row['title'] for row in results}
        assert 'mine' in titles
        assert 'not-mine' not in titles

    def test_list_hides_soft_deleted_workspaces(self):
        visible = WorkspaceFactory(organization=self.organization, title='visible')
        hidden = WorkspaceFactory(organization=self.organization, title='hidden')
        hidden.soft_delete(user=self.owner)

        self.client.force_authenticate(user=self.owner)
        response = self.client.get('/api/workspaces/')

        assert response.status_code == 200
        payload = response.json()
        results = payload['results'] if isinstance(payload, dict) and 'results' in payload else payload
        titles = {row['title'] for row in results}
        assert 'visible' in titles
        assert 'hidden' not in titles
        assert visible.pk in {row['id'] for row in results}

    def test_list_hides_workspaces_user_is_not_member_of(self):
        joined = WorkspaceFactory(organization=self.organization, title='joined')
        WorkspaceFactory(organization=self.organization, title='not-joined')
        member = UserFactory()
        _join_org(member, self.organization)
        WorkspaceMember.objects.create(user=member, workspace=joined, role=WorkspaceMember.Role.MEMBER)

        self.client.force_authenticate(user=member)
        response = self.client.get('/api/workspaces/')

        assert response.status_code == 200
        payload = response.json()
        results = payload['results'] if isinstance(payload, dict) and 'results' in payload else payload
        assert {row['title'] for row in results} == {'joined'}

    def test_unauthenticated_request_denied(self):
        response = self.client.get('/api/workspaces/')
        assert response.status_code in (401, 403)

    def test_list_is_scoped_to_membership_for_regular_users(self):
        """A workspace you don't belong to must not appear in the list — not even its title.

        The detail endpoint already hides it (404); listing it leaked titles and
        descriptions of every workspace in the organization.
        """
        mine = WorkspaceFactory(organization=self.organization, title='mine')
        WorkspaceFactory(organization=self.organization, title='someone-elses')

        member = UserFactory()
        _join_org(member, self.organization)
        WorkspaceMember.objects.create(workspace=mine, user=member, role=WorkspaceMember.Role.MEMBER)

        self.client.force_authenticate(user=member)
        response = self.client.get('/api/workspaces/')

        assert response.status_code == 200
        titles = {row['title'] for row in _results(response)}
        assert titles == {'mine'}

    def test_list_includes_managed_workspaces(self):
        managed = WorkspaceFactory(organization=self.organization, title='managed')
        WorkspaceFactory(organization=self.organization, title='unrelated')

        manager = UserFactory()
        _join_org(manager, self.organization)
        WorkspaceMember.objects.create(
            workspace=managed, user=manager, role=WorkspaceMember.Role.WORKSPACE_MANAGER
        )

        self.client.force_authenticate(user=manager)
        response = self.client.get('/api/workspaces/')

        assert response.status_code == 200
        assert {row['title'] for row in _results(response)} == {'managed'}

    def test_list_hides_workspace_after_membership_is_removed(self):
        workspace = WorkspaceFactory(organization=self.organization, title='temporary')
        member = UserFactory()
        _join_org(member, self.organization)
        membership = WorkspaceMember.objects.create(
            workspace=workspace, user=member, role=WorkspaceMember.Role.MEMBER
        )

        self.client.force_authenticate(user=member)
        assert {row['title'] for row in _results(self.client.get('/api/workspaces/'))} == {'temporary'}

        membership.deleted_at = timezone.now()
        membership.save(update_fields=['deleted_at'])

        assert _results(self.client.get('/api/workspaces/')) == []

    def test_super_admin_sees_every_workspace_in_the_organization(self):
        WorkspaceFactory(organization=self.organization, title='first')
        WorkspaceFactory(organization=self.organization, title='second')

        # The organization owner is the super admin and belongs to neither workspace.
        self.client.force_authenticate(user=self.owner)
        response = self.client.get('/api/workspaces/')

        assert response.status_code == 200
        assert {'first', 'second'} <= {row['title'] for row in _results(response)}

    def test_project_count_is_not_multiplied_by_membership_rows(self):
        """Membership scoping must not turn the annotated project count into a join artifact."""
        workspace = WorkspaceFactory(organization=self.organization, title='counted')
        ProjectFactory(organization=self.organization, workspace=workspace)

        member = UserFactory()
        _join_org(member, self.organization)
        WorkspaceMember.objects.create(workspace=workspace, user=member, role=WorkspaceMember.Role.MEMBER)
        # A second membership row on the same workspace (another member).
        WorkspaceMember.objects.create(
            workspace=workspace,
            user=UserFactory(),
            role=WorkspaceMember.Role.MEMBER,
        )

        self.client.force_authenticate(user=member)
        rows = _results(self.client.get('/api/workspaces/'))

        assert len(rows) == 1
        assert rows[0]['project_count'] == 1


class WorkspaceDetailAPITests(APITestCase):
    def setUp(self):
        self.organization = OrganizationFactory()
        self.owner = self.organization.created_by
        self.workspace = WorkspaceFactory(organization=self.organization, title='detail-ws')

    def test_manager_can_patch(self):
        self.client.force_authenticate(user=self.owner)
        response = self.client.patch(
            f'/api/workspaces/{self.workspace.id}/',
            {'title': 'Renamed'},
            format='json',
        )
        assert response.status_code == 200
        self.workspace.refresh_from_db()
        assert self.workspace.title == 'Renamed'

    def test_non_manager_member_cannot_patch(self):
        # Another user in the same organization, but not a workspace manager.
        member = UserFactory()
        _join_org(member, self.organization)
        WorkspaceMember.objects.create(
            user=member, workspace=self.workspace, role=WorkspaceMember.Role.MEMBER
        )

        self.client.force_authenticate(user=member)
        response = self.client.patch(
            f'/api/workspaces/{self.workspace.id}/',
            {'title': 'Forbidden edit'},
            format='json',
        )
        assert response.status_code == 403

    def test_delete_soft_deletes_workspace(self):
        self.client.force_authenticate(user=self.owner)
        response = self.client.delete(f'/api/workspaces/{self.workspace.id}/')

        assert response.status_code in (200, 204)
        # Default manager hides it.
        assert not Workspace.objects.filter(pk=self.workspace.pk).exists()
        # Row still present in the DB.
        row = Workspace.all_objects.get(pk=self.workspace.pk)
        assert row.deleted_at is not None
        assert row.deleted_by_id == self.owner.id

    def test_cross_org_detail_access_is_hidden(self):
        other_org = OrganizationFactory()
        other_user = other_org.created_by

        self.client.force_authenticate(user=other_user)
        response = self.client.get(f'/api/workspaces/{self.workspace.id}/')
        assert response.status_code == 404


class WorkspaceProjectsAPITests(APITestCase):
    def setUp(self):
        self.organization = OrganizationFactory()
        self.owner = self.organization.created_by
        self.workspace = WorkspaceFactory(organization=self.organization, title='wp-projects')

    def test_returns_only_projects_assigned_to_workspace(self):
        in_ws = ProjectFactory(organization=self.organization, title='inside-ws')
        in_ws.workspace = self.workspace
        in_ws.save(update_fields=['workspace'])

        ProjectFactory(organization=self.organization, title='no-workspace')

        self.client.force_authenticate(user=self.owner)
        response = self.client.get(f'/api/workspaces/{self.workspace.id}/projects/')

        assert response.status_code == 200
        payload = response.json()
        results = payload['results'] if isinstance(payload, dict) and 'results' in payload else payload
        titles = {row['title'] for row in results}
        assert 'inside-ws' in titles
        assert 'no-workspace' not in titles

    def test_cross_org_cannot_list_projects(self):
        other_org = OrganizationFactory()
        other_user = other_org.created_by

        self.client.force_authenticate(user=other_user)
        response = self.client.get(f'/api/workspaces/{self.workspace.id}/projects/')
        # Either 403 (org mismatch) or 404 (parent queryset not found).
        assert response.status_code in (403, 404)
