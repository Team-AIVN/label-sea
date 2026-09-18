/**
 * TC-AC-* : 접근 권한 매트릭스 (API 레벨)
 *
 * 왜 API 로 먼저 검증하는가: UI 는 메뉴를 숨겨 줄 뿐이고, 실제 차단은 백엔드가 한다.
 * URL 을 직접 치고 들어오는 경우까지 막히는지 보려면 API 응답을 봐야 한다.
 *
 * 배정 현황(lib/fixtures.mjs 기준):
 *   워크스페이스 A(WM1) : A1(PM1, 작업자1·작업자2, 검수자1), A2(PM2, 작업자1, 검수자1)
 *   워크스페이스 B(WM2) : B1(PM3, 작업자1·작업자3, 검수자2), B2(PM4, 작업자3, 검수자2)
 * → 작업자1 = 워크스페이스를 넘나드는 멀티 프로젝트 작업자
 * → 작업자3 = 워크스페이스 A 에 대해 완전한 외부인 (부정 테스트 대상)
 */
import { expect, test } from '@playwright/test';

import { ACCOUNTS, PROJECTS, WORKSPACES, projectsOf } from '../../lib/fixtures.mjs';
import { seeded } from '../../lib/auth.mjs';
import { clientFor } from '../../lib/api.mjs';

const data = seeded();
const projectId = (key) => data.projects[key].id;
const workspaceId = (key) => data.workspaces[key].id;

/** 계정 키 → 로그인된 API 클라이언트 (파일 전체에서 재사용). */
const clients = {};
const as = async (key) => (clients[key] ??= await clientFor(ACCOUNTS[key]));

test.describe('TC-AC 접근 권한', () => {
  test('TC-AC-001 작업자는 자신이 배정된 프로젝트만 프로젝트 목록에서 본다', async () => {
    for (const accountKey of ['annotator1', 'annotator2', 'annotator3', 'reviewer1', 'reviewer2']) {
      const client = await as(accountKey);
      const response = await client.get('/api/projects/?page_size=100');
      const visible = (response.results ?? response).map((p) => p.id).sort();
      const expected = projectsOf(accountKey)
        .map((p) => projectId(p.key))
        .sort();
      expect(visible, `${accountKey} 가 보는 프로젝트 목록`).toEqual(expected);
    }
  });

  test('TC-AC-002 워크스페이스 매니저는 자기 워크스페이스의 모든 프로젝트를 본다', async () => {
    const wm1 = await as('wm1');
    const list = await wm1.get(`/api/workspaces/${workspaceId('wsA')}/projects/`);
    expect(list.map((p) => p.id).sort()).toEqual([projectId('a1'), projectId('a2')].sort());
  });

  test('TC-AC-003 비멤버는 남의 워크스페이스 상세를 열 수 없다 (404)', async () => {
    const annotator3 = await as('annotator3'); // 워크스페이스 A 비멤버
    const res = await annotator3.raw('GET', `/api/workspaces/${workspaceId('wsA')}/`);
    expect(res.status).toBe(404);
  });

  test('TC-AC-004 비멤버는 워크스페이스 하위 리소스에 접근할 수 없다 (403)', async () => {
    const annotator3 = await as('annotator3');
    const wsA = workspaceId('wsA');
    for (const path of [
      `/api/workspaces/${wsA}/members/`,
      `/api/workspaces/${wsA}/projects/`,
      `/api/workspaces/${wsA}/task-pools/`,
      `/api/workspaces/${wsA}/summary/`,
    ]) {
      const res = await annotator3.raw('GET', path);
      expect(res.status, path).toBe(403);
    }
  });

  test('TC-AC-005 워크스페이스 목록은 조직 전체가 보인다 (현재 동작 기록용)', async () => {
    // 주의: 목록은 멤버십으로 걸러지지 않는다(workspaces/api.py 의 get_queryset).
    // 상세·하위 리소스에서 막히므로 데이터 유출은 제목/설명 수준이다.
    // 이 정책이 바뀌면 이 테스트가 먼저 깨지도록 기대값을 명시해 둔다.
    const annotator3 = await as('annotator3');
    const titles = (await annotator3.get('/api/workspaces/')).map((w) => w.title);
    expect(titles).toContain(WORKSPACES.wsA.title);
    expect(titles).toContain(WORKSPACES.wsB.title);
  });

  test('TC-AC-006 비멤버는 프로젝트를 수정할 수 없다 (403)', async () => {
    const annotator3 = await as('annotator3');
    const res = await annotator3.raw('PATCH', `/api/projects/${projectId('a1')}/`, {
      json: { title: '침입자가 바꾼 제목' },
    });
    expect(res.status).toBe(403);
  });

  test('TC-AC-007 작업자는 멤버 배정을 바꿀 수 없다 (403)', async () => {
    const annotator1 = await as('annotator1'); // A1 의 작업자(멤버이긴 하다)
    const res = await annotator1.raw('POST', `/api/projects/${projectId('a1')}/members/`, {
      json: { user: data.users.annotator3, role: 'annotator' },
    });
    expect(res.status).toBe(403);
  });

  test('TC-AC-008 PM 은 자기 프로젝트의 멤버를 배정/해제할 수 있다', async () => {
    const pm1 = await as('pm1');
    const url = `/api/projects/${projectId('a1')}/members/`;
    // 배정 대상으로 PM2 를 쓴다: 이미 워크스페이스 A 멤버(A2 의 PM)라서
    // 이 테스트가 "워크스페이스 비멤버" 상태를 오염시키지 않는다.
    const target = data.users.pm2;

    const created = await pm1.post(url, { user: target, role: 'annotator' });
    expect(created.role).toBe('annotator');

    const members = await pm1.get(url);
    expect(members.map((m) => m.user)).toContain(target);

    await pm1.del(`${url}${created.id}/`);
    const after = await pm1.get(url);
    expect(after.map((m) => m.user)).not.toContain(target);
  });

  test('TC-AC-009 검수자는 배정되지 않은 프로젝트의 검수 대상을 조회할 수 없다 (403)', async () => {
    const reviewer2 = await as('reviewer2'); // 워크스페이스 B 전용 검수자
    const res = await reviewer2.raw('GET', `/api/projects/${projectId('a1')}/review/candidates/`);
    expect(res.status).toBe(403);
  });

  test('TC-AC-010 검수자는 배정된 프로젝트의 검수 대상을 조회할 수 있다', async () => {
    const reviewer1 = await as('reviewer1');
    const res = await reviewer1.raw('GET', `/api/projects/${projectId('a1')}/review/candidates/`);
    expect(res.status).toBe(200);
  });

  test('TC-AC-011 작업자1은 워크스페이스를 넘나들며 배정된 3개 프로젝트를 모두 연다', async () => {
    const annotator1 = await as('annotator1');
    for (const key of ['a1', 'a2', 'b1']) {
      const res = await annotator1.raw('GET', `/api/projects/${projectId(key)}/`);
      expect(res.status, PROJECTS[key].title).toBe(200);
      expect(res.data.current_user_role).toBe('annotator');
    }
  });

  test('TC-AC-012 워크스페이스 매니저만 태스크 풀을 만들 수 있다', async () => {
    const wsB = workspaceId('wsB');

    const annotator3 = await as('annotator3'); // 워크스페이스 B 의 일반 멤버
    const denied = await annotator3.raw('POST', `/api/workspaces/${wsB}/task-pools/`, {
      json: { title: '[E2E] 작업자가 만든 풀' },
    });
    expect(denied.status).toBe(403);

    const wm2 = await as('wm2');
    const created = await wm2.post(`/api/workspaces/${wsB}/task-pools/`, { title: '[E2E] 임시 풀' });
    expect(created.id).toBeTruthy();
    await wm2.del(`/api/workspaces/${wsB}/task-pools/${created.id}/`);
  });

  test('TC-AC-013 워크스페이스 매니저는 새 워크스페이스를 만들 수 있고, 일반 작업자는 못 만든다', async () => {
    const annotator1 = await as('annotator1');
    const denied = await annotator1.raw('POST', '/api/workspaces/', { json: { title: '[E2E] 작업자가 만든 WS' } });
    expect(denied.status).toBe(403);

    const wm1 = await as('wm1');
    const created = await wm1.post('/api/workspaces/', { title: '[E2E] WM1 이 만든 임시 워크스페이스' });
    expect(created.current_user_role).toBe('workspace_manager');
    await wm1.del(`/api/workspaces/${created.id}/`);
  });

  /**
   * 알려진 버그(제품 결함) 기록.
   *
   * 워크스페이스 멤버를 해제(soft delete)한 뒤 같은 사람을 그 워크스페이스의 프로젝트
   * 멤버로 다시 배정하면 500 이 난다:
   *   projects/members_api.py:136-138 이 WorkspaceMember 에 없는 `deleted_by` 필드를
   *   설정하고 update_fields 에 넣어 저장 → ValueError
   *   (Workspace 모델에는 deleted_by 가 있지만 WorkspaceMember 에는 없다 —
   *    workspaces/models.py:118-157)
   *
   * 고쳐지면 이 테스트가 "예상외 통과"로 뜨면서 알려 준다 (test.fail).
   */
  test.fail('TC-AC-014 [알려진 버그] 해제했던 워크스페이스 멤버를 프로젝트에 재배정하면 500', async () => {
    const wm1 = await as('wm1');
    const pm1 = await as('pm1');
    const wsA = workspaceId('wsA');
    const projectUrl = `/api/projects/${projectId('a1')}/members/`;

    // 준비: 대상(작업자3)을 A1 에 넣었다가 워크스페이스 멤버에서 해제한다.
    const projectMember = await pm1.post(projectUrl, { user: data.users.annotator3, role: 'annotator' });
    await pm1.del(`${projectUrl}${projectMember.id}/`);
    const wsMembers = await wm1.get(`/api/workspaces/${wsA}/members/`);
    const stale = wsMembers.find((m) => m.user === data.users.annotator3);
    if (stale) await wm1.del(`/api/workspaces/${wsA}/members/${stale.id}/`);

    // 재배정 → 기대: 201, 실제: 500
    const res = await pm1.raw('POST', projectUrl, { json: { user: data.users.annotator3, role: 'annotator' } });
    expect(res.status).toBe(201);
  });
});
