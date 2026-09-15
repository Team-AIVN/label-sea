"""Data Manager actions that assign project tasks to labelers.

A task has at most one labeler (``Task.assignee``). Project managers pick a labeler for
the selected tasks. A task that already belongs to a different labeler is never taken
over silently: the whole assignment is rejected until that task is unassigned. Labelers
then see and work on only the tasks assigned to them (``users.rules.visible_tasks``).
Reviewers are out of scope and keep access to every task.
"""

import logging

from core.permissions import AllPermissions
from data_manager.actions import DataManagerAction
from django.db import transaction
from django.utils import timezone
from projects.models import ProjectMember
from rest_framework.exceptions import ValidationError
from tasks.models import Task
from users.constants import ProjectRole
from users.rules import is_project_manager_of, is_super_admin

all_permissions = AllPermissions()
logger = logging.getLogger(__name__)


def _can_assign(user, project):
    return is_super_admin.test(user) or is_project_manager_of.test(user, project)


def _assignable_members(project):
    return (
        ProjectMember.objects.filter(
            project=project,
            role=ProjectRole.ANNOTATOR,
            enabled=True,
            deleted_at__isnull=True,
            user__is_active=True,
        )
        .select_related('user')
        .order_by('user__email')
    )


def _user_label(user):
    return user.get_full_name() or user.username or user.email


def assign_tasks(project, queryset, **kwargs):
    """Assign the selected unassigned tasks to one labeler.

    Rejected as a whole if any selected task belongs to a different labeler. Tasks that
    already belong to the chosen labeler are left untouched.
    """
    request = kwargs['request']
    try:
        labeler_id = int(request.data.get('labeler'))
    except (TypeError, ValueError):
        raise ValidationError({'labeler': '할당할 라벨러를 선택하세요.'})

    with transaction.atomic():
        # Lock the membership until the tasks are updated. A concurrent role change or
        # removal either waits and then releases these assignments, or commits first so
        # this lookup no longer finds an active labeler.
        member = _assignable_members(project).select_for_update(of=('self',)).filter(user_id=labeler_id).first()
        if member is None:
            raise ValidationError({'labeler': '이 프로젝트의 활성 라벨러에게만 할당할 수 있습니다.'})

        task_ids = list(queryset.values_list('id', flat=True))
        # Serialize overlapping assign/unassign actions on the selected task rows.
        # Without this lock two managers can both pass the conflict check and the
        # loser can report a partial or zero-item success.
        task_rows = list(
            Task.objects.select_for_update(of=('self',))
            .filter(project=project, id__in=task_ids)
            .order_by('id')
            .values_list('id', 'assignee_id')
        )

        conflicts = sum(assignee_id not in (None, member.user_id) for _, assignee_id in task_rows)
        if conflicts:
            raise ValidationError(
                {'labeler': f'선택한 태스크 중 {conflicts}개는 이미 다른 라벨러에게 할당돼 있습니다. 먼저 할당을 해제하세요.'}
            )

        already_assigned = sum(assignee_id == member.user_id for _, assignee_id in task_rows)
        unassigned_ids = [task_id for task_id, assignee_id in task_rows if assignee_id is None]
        count = Task.objects.filter(id__in=unassigned_ids, assignee__isnull=True).update(
            assignee=member.user, assigned_at=timezone.now(), assigned_by=request.user
        )
        if count != len(unassigned_ids):
            # Protect the all-or-nothing contract even if another code path updates an
            # assignment without taking the task-row lock.
            raise ValidationError({'labeler': '할당 상태가 동시에 변경되었습니다. 새로고침한 뒤 다시 시도하세요.'})
    logger.info(f'User={request.user} assigned {count} tasks of project={project.id} to user={member.user_id}')

    detail = f'{count}개 태스크를 {_user_label(member.user)}에게 할당했습니다.'
    if already_assigned:
        detail += f' ({already_assigned}개는 이미 할당돼 있었습니다.)'
    return {'processed_items': count, 'detail': detail}


def unassign_tasks(project, queryset, **kwargs):
    """Clear the labeler of the selected tasks, hiding them from labelers again."""
    request = kwargs['request']
    with transaction.atomic():
        task_ids = list(queryset.values_list('id', flat=True))
        locked_ids = list(
            Task.objects.select_for_update(of=('self',))
            .filter(project=project, id__in=task_ids)
            .order_by('id')
            .values_list('id', flat=True)
        )
        count = Task.objects.filter(id__in=locked_ids, assignee__isnull=False).update(
            assignee=None, assigned_at=None, assigned_by=None
        )
    logger.info(f'User={request.user} unassigned {count} tasks of project={project.id}')
    return {'processed_items': count, 'detail': f'{count}개 태스크의 라벨러 할당을 해제했습니다.'}


def assign_tasks_form(user, project):
    return [
        {
            'columnCount': 1,
            'fields': [
                {
                    'type': 'select',
                    'name': 'labeler',
                    'label': '라벨러',
                    'options': [
                        {'value': str(member.user_id), 'label': _user_label(member.user)}
                        for member in _assignable_members(project)
                    ],
                    'searchable': True,
                }
            ],
        }
    ]


actions: list[DataManagerAction] = [
    {
        'entry_point': assign_tasks,
        'permission': all_permissions.tasks_change,
        'project_permission': _can_assign,
        'title': '라벨러 할당',
        'order': 80,
        'dialog': {
            'title': '라벨러 할당',
            'text': '선택한 태스크를 라벨러에게 할당합니다. '
            '다른 라벨러에게 이미 할당된 태스크가 섞여 있으면 할당되지 않으니, 먼저 할당을 해제하세요.',
            'type': 'confirm',
            'form': assign_tasks_form,
        },
    },
    {
        'entry_point': unassign_tasks,
        'permission': all_permissions.tasks_change,
        'project_permission': _can_assign,
        'title': '라벨러 할당 해제',
        'order': 81,
        'dialog': {
            'title': '라벨러 할당 해제',
            'text': '선택한 태스크의 라벨러 할당을 해제합니다. 할당이 해제된 태스크는 라벨러에게 보이지 않습니다.',
            'type': 'confirm',
        },
    },
]
