/**
 * TC-TA-* : 태스크 라벨러 할당 (feat/task-assignment)
 *
 * 기능 요약
 *   - 태스크 한 건에는 라벨러가 최대 한 명(`Task.assignee`). PM/슈퍼 관리자가 배정한다.
 *   - 배정은 Data Manager 액션으로 한다:
 *       POST /api/dm/actions/?id=assign_tasks&project=<id>
 *         { selectedItems: { all: false, included: [taskId...] }, labeler: "<userId>" }
 *       POST /api/dm/actions/?id=unassign_tasks&project=<id>
 *         { selectedItems: { all: false, included: [taskId...] } }
 *   - 라벨러는 자기에게 할당된 태스크만 보고 작업할 수 있다(users.rules.visible_tasks).
 *     검수자와 PM 은 제한을 받지 않는다.
 *   - 이미 다른 라벨러에게 할당된 태스크가 섞이면 **부분 성공 없이 전부 거부**된다.
 *
 * 시드는 프로젝트마다 태스크를 라벨러들에게 나눠 할당해 둔다(seed/seed.mjs 의 assignTasks).
 * 그래서 이 파일의 테스트는 "이미 할당된 상태"에서 시작한다.
 *
 * 할당 상태를 바꾸는 테스트는 B1 프로젝트만 쓴다 — A1 은 라벨링·검수 시나리오(TC-WF)가
 * 태스크를 소비하므로 서로 건드리지 않게 분리한다.
 */
import { expect, test } from '@playwright/test';

import { ACCOUNTS, choiceResult } from '../../lib/fixtures.mjs';
import { seeded } from '../../lib/auth.mjs';
import { clientFor } from '../../lib/api.mjs';

const data = seeded();
const B1 = data.projects.b1.id; // PM3 / 작업자1·작업자3 / 검수자2, 태스크 8건

const clients = {};
const as = async (key) => (clients[key] ??= await clientFor(ACCOUNTS[key]));

/** DM 태스크 목록. 라벨러 배정은 `labeler` 필드(사용자 id 배열)로 드러난다. */
const taskList = async (accountKey, projectId) => {
  const client = await as(accountKey);
  return client.get(`/api/tasks/?project=${projectId}&page_size=1000`);
};

const assign = async (accountKey, projectId, taskIds, labelerUserId) =>
  (await as(accountKey)).raw('POST', `/api/dm/actions/?id=assign_tasks&project=${projectId}`, {
    json: { selectedItems: { all: false, included: taskIds }, labeler: String(labelerUserId) },
  });

const unassign = async (accountKey, projectId, taskIds) =>
  (await as(accountKey)).raw('POST', `/api/dm/actions/?id=unassign_tasks&project=${projectId}`, {
    json: { selectedItems: { all: false, included: taskIds } },
  });

/** 라벨러가 바뀐 태스크를 원래 주인에게 돌려놓는다 (다른 테스트와의 간섭 방지). */
const restore = async (projectId, taskIds, labelerUserId) => {
  await unassign('pm3', projectId, taskIds);
  if (labelerUserId) await assign('pm3', projectId, taskIds, labelerUserId);
};

test.describe('TC-TA 태스크 라벨러 할당', () => {
  test('TC-TA-001 할당 액션은 PM 에게만 보인다', async () => {
    const actionsOf = async (key) =>
      (await (await as(key)).get(`/api/dm/actions/?project=${B1}`)).map((a) => a.id);

    expect(await actionsOf('pm3')).toEqual(expect.arrayContaining(['assign_tasks', 'unassign_tasks']));

    for (const key of ['annotator1', 'annotator3', 'reviewer2']) {
      const ids = await actionsOf(key);
      expect(ids, `${key} 의 액션 목록`).not.toContain('assign_tasks');
      expect(ids, `${key} 의 액션 목록`).not.toContain('unassign_tasks');
    }
  });

  test('TC-TA-002 라벨러/검수자는 할당·해제를 실행할 수 없다 (403)', async () => {
    const { tasks } = await taskList('pm3', B1);
    const target = tasks[0].id;

    const byAnnotator = await assign('annotator1', B1, [target], data.users.annotator1);
    expect(byAnnotator.status).toBe(403);

    const byReviewer = await unassign('reviewer2', B1, [target]);
    expect(byReviewer.status).toBe(403);
  });

  test('TC-TA-003 할당 후보는 그 프로젝트의 라벨러뿐이다', async () => {
    const pm3 = await as('pm3');
    const form = await pm3.get(`/api/dm/actions/assign_tasks/form?project=${B1}`);
    const options = form[0].fields.find((f) => f.name === 'labeler').options;

    expect(options.map((o) => o.value).sort()).toEqual(
      [String(data.users.annotator1), String(data.users.annotator3)].sort(),
    );
    // PM·검수자는 후보에 없다
    expect(options.map((o) => o.value)).not.toContain(String(data.users.reviewer2));
    expect(options.map((o) => o.value)).not.toContain(String(data.users.pm3));
  });

  test('TC-TA-004 라벨러가 아닌 사람에게는 할당할 수 없다 (400)', async () => {
    const { tasks } = await taskList('pm3', B1);
    const target = tasks[0].id;

    const toReviewer = await assign('pm3', B1, [target], data.users.reviewer2);
    expect(toReviewer.status).toBe(400);
    expect(JSON.stringify(toReviewer.data)).toContain('활성 라벨러');

    const toOutsider = await assign('pm3', B1, [target], data.users.annotator2); // B1 멤버가 아님
    expect(toOutsider.status).toBe(400);
  });

  test('TC-TA-005 라벨러는 자기에게 할당된 태스크만 본다', async () => {
    const all = await taskList('pm3', B1);
    const expected = {
      annotator1: new Set(data.projects.b1.assignments.annotator1.taskIds),
      annotator3: new Set(data.projects.b1.assignments.annotator3.taskIds),
    };

    for (const key of ['annotator1', 'annotator3']) {
      const mine = await taskList(key, B1);
      expect(mine.total, `${key} 가 보는 태스크 수`).toBe(expected[key].size);
      expect(new Set(mine.tasks.map((t) => t.id))).toEqual(expected[key]);
    }

    // 검수자와 PM 은 전체를 본다
    expect((await taskList('reviewer2', B1)).total).toBe(all.total);
    expect(all.total).toBe(data.projects.b1.taskCount);
  });

  test('TC-TA-006 라벨러는 할당되지 않은 태스크를 열거나 작업할 수 없다 (404)', async () => {
    const annotator1 = await as('annotator1');
    const othersTask = data.projects.b1.assignments.annotator3.taskIds[0];

    const read = await annotator1.raw('GET', `/api/tasks/${othersTask}/`);
    expect(read.status).toBe(404);

    const write = await annotator1.raw('POST', `/api/tasks/${othersTask}/annotations/`, {
      json: { result: choiceResult('긍정') },
    });
    expect(write.status).toBe(404);
  });

  test('TC-TA-007 라벨 스트림은 할당된 태스크만 내주고, 할당이 없으면 비어 있다', async () => {
    const annotator1 = await as('annotator1');
    const mine = new Set(data.projects.b1.assignments.annotator1.taskIds);

    const next = await annotator1.raw('GET', `/api/projects/${B1}/next/`);
    expect(next.status).toBe(200);
    expect(mine.has(next.data.id), '내게 할당된 태스크가 나와야 한다').toBe(true);

    // 작업자2 는 B1 멤버가 아니므로 애초에 받을 태스크가 없다
    const outsider = await as('annotator2');
    const denied = await outsider.raw('GET', `/api/projects/${B1}/next/`);
    expect([403, 404]).toContain(denied.status);
  });

  test('TC-TA-008 PM 이 미할당 태스크를 할당하면 라벨러에게 보이기 시작한다', async () => {
    const mineIds = data.projects.b1.assignments.annotator1.taskIds;
    const target = mineIds[0];

    // 먼저 해제해서 "미할당" 상태를 만든다
    const cleared = await unassign('pm3', B1, [target]);
    expect(cleared.status).toBe(200);
    expect(cleared.data.processed_items).toBe(1);
    expect((await taskList('annotator1', B1)).tasks.map((t) => t.id)).not.toContain(target);

    const result = await assign('pm3', B1, [target], data.users.annotator1);
    expect(result.status).toBe(200);
    expect(result.data.processed_items).toBe(1);
    expect(result.data.detail).toContain(ACCOUNTS.annotator1.name);

    const after = await taskList('annotator1', B1);
    expect(after.tasks.map((t) => t.id)).toContain(target);
    // DM 목록의 labeler 컬럼에도 반영된다
    const row = (await taskList('pm3', B1)).tasks.find((t) => t.id === target);
    expect(row.labeler).toEqual([data.users.annotator1]);
  });

  test('TC-TA-009 다른 라벨러 태스크가 섞이면 전부 거부된다 (부분 성공 없음)', async () => {
    const mine = data.projects.b1.assignments.annotator1.taskIds[1];
    const others = data.projects.b1.assignments.annotator3.taskIds[0];

    // 미할당 1건 + 남의 것 1건을 섞어 요청한다
    await unassign('pm3', B1, [mine]);
    const result = await assign('pm3', B1, [mine, others], data.users.annotator1);

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.data)).toContain('이미 다른 라벨러');

    // 미할당이던 건도 그대로 미할당이어야 한다 — 일부만 처리되면 안 된다
    const rows = (await taskList('pm3', B1)).tasks;
    expect(rows.find((t) => t.id === mine).labeler).toEqual([]);
    expect(rows.find((t) => t.id === others).labeler).toEqual([data.users.annotator3]);

    await restore(B1, [mine], data.users.annotator1);
  });

  test('TC-TA-010 같은 라벨러에게 다시 할당해도 안전하다 (멱등)', async () => {
    const ids = data.projects.b1.assignments.annotator1.taskIds.slice(0, 2);

    const result = await assign('pm3', B1, ids, data.users.annotator1);
    expect(result.status).toBe(200);
    expect(result.data.processed_items, '이미 할당된 건은 새로 처리되지 않는다').toBe(0);
    expect(result.data.detail).toContain('이미 할당');

    expect((await taskList('annotator1', B1)).tasks.map((t) => t.id)).toEqual(
      expect.arrayContaining(ids),
    );
  });

  test('TC-TA-011 labeler 값 없이 할당하면 거부된다 (400)', async () => {
    const pm3 = await as('pm3');
    const target = data.projects.b1.assignments.annotator1.taskIds[0];

    const result = await pm3.raw('POST', `/api/dm/actions/?id=assign_tasks&project=${B1}`, {
      json: { selectedItems: { all: false, included: [target] } },
    });
    expect(result.status).toBe(400);
  });

  test('TC-TA-012 내보내기 결과에는 할당 필드가 들어가지 않는다', async () => {
    const pm3 = await as('pm3');
    const result = await pm3.raw('GET', `/api/projects/${B1}/export?exportType=JSON&download_all_tasks=true`);

    expect(result.status).toBe(200);
    const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    for (const field of ['assignee', 'assigned_by', 'assigned_at']) {
      expect(body, `내보내기에 ${field} 가 있으면 안 된다`).not.toContain(field);
    }
  });

  test('TC-TA-013 할당된 태스크는 라벨링·검수 흐름을 그대로 탄다', async () => {
    const annotator3 = await as('annotator3');
    const reviewer2 = await as('reviewer2');

    const task = await annotator3.get(`/api/projects/${B1}/next/`);
    expect(new Set(data.projects.b1.assignments.annotator3.taskIds).has(task.id)).toBe(true);

    const annotation = await annotator3.post(`/api/tasks/${task.id}/annotations/`, {
      result: choiceResult('중립'),
    });
    const afterSubmit = await reviewer2.get(`/api/tasks/${task.id}/`);
    expect(afterSubmit.review_status).toBe('PENDING');

    await reviewer2.post(`/api/annotations/${annotation.id}/review/`, { decision: 'ACCEPT' });
    const afterReview = await reviewer2.get(`/api/tasks/${task.id}/`);
    expect(afterReview.review_status).toBe('ACCEPTED');
  });
});
