from django.db import migrations


BATCH_SIZE = 1000


def _add_candidate(candidates, task_id, user_id):
    if user_id is not None and user_id not in candidates[task_id]:
        candidates[task_id].append(user_id)


def backfill_task_assignee(apps, schema_editor):
    """Assign previously worked tasks to an eligible current project annotator.

    Candidates are tried in order and the first eligible one wins: the current
    annotation's author, then authors of non-cancelled annotations (newest first),
    then authors of drafts, postponed ones included (most recently updated first).
    Eligible means an active user with an enabled annotator membership in the
    task's project; tasks without an eligible candidate stay unassigned.
    """
    Task = apps.get_model('tasks', 'Task')
    Annotation = apps.get_model('tasks', 'Annotation')
    AnnotationDraft = apps.get_model('tasks', 'AnnotationDraft')
    ProjectMember = apps.get_model('projects', 'ProjectMember')

    last_id = 0
    while True:
        rows = list(
            Task.objects.filter(id__gt=last_id, assignee__isnull=True)
            .order_by('id')
            .values('id', 'project_id', 'current_annotation__completed_by_id', 'updated_at')[:BATCH_SIZE]
        )
        if not rows:
            break
        last_id = rows[-1]['id']

        task_ids = [row['id'] for row in rows]
        candidates = {task_id: [] for task_id in task_ids}
        for row in rows:
            _add_candidate(candidates, row['id'], row['current_annotation__completed_by_id'])
        for task_id, user_id in (
            Annotation.objects.filter(task_id__in=task_ids, was_cancelled=False, completed_by_id__isnull=False)
            .order_by('task_id', '-created_at', '-id')
            .values_list('task_id', 'completed_by_id')
        ):
            _add_candidate(candidates, task_id, user_id)
        for task_id, user_id in (
            AnnotationDraft.objects.filter(task_id__in=task_ids)
            .order_by('task_id', '-updated_at', '-id')
            .values_list('task_id', 'user_id')
        ):
            _add_candidate(candidates, task_id, user_id)

        eligible = set(
            ProjectMember.objects.filter(
                project_id__in={row['project_id'] for row in rows},
                user_id__in={user_id for user_ids in candidates.values() for user_id in user_ids},
                role='annotator',
                enabled=True,
                deleted_at__isnull=True,
                user__is_active=True,
            ).values_list('project_id', 'user_id')
        )

        updates = []
        for row in rows:
            assignee_id = next(
                (user_id for user_id in candidates[row['id']] if (row['project_id'], user_id) in eligible), None
            )
            if assignee_id is not None:
                updates.append(Task(id=row['id'], assignee_id=assignee_id, assigned_at=row['updated_at']))

        if updates:
            Task.objects.bulk_update(updates, ['assignee', 'assigned_at'], batch_size=BATCH_SIZE)


class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ('tasks', '0063_task_assignment_fields'),
        # ProjectMember.deleted_at and the current role values used by the backfill.
        ('projects', '0042_alter_projectmember_role'),
    ]

    operations = [
        # Assignment data is deliberately preserved on a code rollback. There is
        # no safe way to distinguish this backfill from later manual assignment
        # after assigned_by users are deleted, so the reverse is a no-op.
        migrations.RunPython(backfill_task_assignee, migrations.RunPython.noop),
    ]
