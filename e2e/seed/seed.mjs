/**
 * 목 데이터 시드: 워크스페이스 2개 × 프로젝트 2개 + 태스크 풀 + 멤버 배정.
 *
 * 전제:
 *   1) e2e/seed/signup.sh   — 계정 11개
 *   2) e2e/seed/bootstrap.sh — 워크스페이스 2개 + WM 지정 (최초 1회, 관리자 권한 필요)
 *
 * 이 스크립트는 그 다음부터를 전부 공개 REST API 로 한다 — 실제 사용자가 화면에서
 * 하는 것과 같은 경로라서, 시드 자체가 API 스모크 테스트 역할도 한다.
 *
 * 주의: 워크스페이스 목록이 멤버십으로 걸러지므로(feat/workspace-list-membership-filter),
 * 시드는 각 워크스페이스의 매니저 계정으로 그 워크스페이스를 찾는다.
 *
 * 멱등성: [E2E] 로 시작하는 프로젝트/태스크 풀은 매 실행마다 지우고 새로 만든다.
 *         워크스페이스와 계정은 유지한다.
 *
 * 사용법:  node e2e/seed/seed.mjs            (기본 http://localhost:8080)
 *          LS_BASE_URL=... node e2e/seed/seed.mjs
 *          node e2e/seed/seed.mjs --json     (결과 id 들을 JSON 으로만 출력)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { clientFor } from '../lib/api.mjs';
import { ACCOUNTS, LABEL_CONFIG, PROJECTS, WORKSPACES, taskTexts } from '../lib/fixtures.mjs';

const jsonOnly = process.argv.includes('--json');
const log = (...args) => {
  if (!jsonOnly) console.log(...args);
};

/** 워크스페이스 매니저 클라이언트를 워크스페이스 key 별로 준비한다. */
const managerClients = async () => {
  const entries = await Promise.all(
    Object.values(WORKSPACES).map(async (ws) => [ws.key, await clientFor(ACCOUNTS[ws.manager])]),
  );
  return Object.fromEntries(entries);
};

/** 제목으로 워크스페이스를 찾는다. 없으면 bootstrap 이 안 돌았다는 뜻. */
const findWorkspace = async (client, title) => {
  const list = await client.get('/api/workspaces/');
  const found = list.find((w) => w.title === title);
  if (!found) {
    throw new Error(
      `워크스페이스를 찾지 못했습니다: ${title}\n` +
        `먼저 e2e/seed/bootstrap.sh 를 실행하세요 (워크스페이스 최초 생성은 관리자 권한이 필요합니다).`,
    );
  }
  return found;
};

/**
 * 이전 실행이 남긴 [E2E] 프로젝트/풀을 지우고, 워크스페이스 멤버를 매니저만 남긴다.
 *
 * 멤버십까지 되돌리는 이유: 프로젝트 멤버로 배정하면 해당 워크스페이스 멤버가 자동으로
 * 추가된다(projects/members_api.py `_ensure_workspace_membership`). 그래서 한 번이라도
 * 배정을 테스트하면 "비멤버" 계정이 멤버로 남아, 접근 거부 테스트가 다음 실행에서 깨진다.
 */
const cleanWorkspace = async (client, workspaceId) => {
  const projects = await client.get(`/api/workspaces/${workspaceId}/projects/`);
  for (const project of projects) {
    if (project.title?.startsWith('[E2E]')) {
      await client.del(`/api/projects/${project.id}/`);
      log(`  - 기존 프로젝트 삭제: ${project.id} ${project.title}`);
    }
  }
  const pools = await client.get(`/api/workspaces/${workspaceId}/task-pools/`);
  for (const pool of pools) {
    if (pool.title?.startsWith('[E2E]')) {
      await client.del(`/api/workspaces/${workspaceId}/task-pools/${pool.id}/`);
      log(`  - 기존 태스크 풀 삭제: ${pool.id} ${pool.title}`);
    }
  }

  // 매니저 외의 워크스페이스 멤버는 해제한다.
  // 프로젝트 멤버로 배정하면 워크스페이스 멤버가 자동으로 추가되므로(members_api.py 의
  // _ensure_workspace_membership), 이전 실행이 남긴 멤버십을 지우지 않으면
  // "비멤버" 접근 거부 테스트가 다음 실행에서 깨진다.
  const members = await client.get(`/api/workspaces/${workspaceId}/members/`);
  for (const member of members) {
    if (member.role !== 'workspace_manager') {
      await client.del(`/api/workspaces/${workspaceId}/members/${member.id}/`);
      log(`  - 워크스페이스 멤버 해제: ${member.user_detail?.email ?? member.user}`);
    }
  }
};

/**
 * 태스크 원본 업로드 → 태스크 풀 생성 → 풀에 아이템 담기.
 * 업로드한 JSON 한 건이 TaskSourceItem 여러 건으로 펼쳐진다.
 */
const createPool = async (client, workspaceId, project) => {
  const texts = taskTexts(project.textPrefix, project.taskCount);
  const upload = await client.uploadTasks(
    workspaceId,
    `${project.key}-tasks.json`,
    texts.map((text) => ({ text })),
  );
  const datasetId = upload.files[0].id;

  const items = await client.get(`/api/workspaces/${workspaceId}/task-source-items/?dataset=${datasetId}`);
  if (items.length !== texts.length) {
    throw new Error(`태스크 원본 개수가 예상과 다릅니다: ${items.length} (예상 ${texts.length})`);
  }

  const pool = await client.post(`/api/workspaces/${workspaceId}/task-pools/`, {
    title: project.poolTitle,
    description: `${project.title} 용 태스크 풀`,
  });
  await client.post(`/api/workspaces/${workspaceId}/task-pools/${pool.id}/items/`, {
    task_source_item_ids: items.map((i) => i.id),
  });
  log(`  - 태스크 풀 생성: ${pool.id} ${pool.title} (아이템 ${items.length})`);
  return pool;
};

/** 프로젝트 생성 → 풀 연결(=태스크 생성) → 멤버 배정. */
const createProject = async (client, workspaceId, project, userIdByKey) => {
  const created = await client.post('/api/projects/', {
    title: project.title,
    description: project.description,
    label_config: LABEL_CONFIG,
    workspace: workspaceId,
    task_pool: project.poolId,
    review_strategy: project.reviewStrategy,
    review_ratio: project.reviewRatio,
    is_draft: false,
    is_published: true,
  });
  log(`  - 프로젝트 생성: ${created.id} ${created.title} (검수전략 ${project.reviewStrategy})`);

  for (const [accountKey, role] of Object.entries(project.members)) {
    await client.post(`/api/projects/${created.id}/members/`, {
      user: userIdByKey[accountKey],
      role,
      enabled: true,
    });
  }
  log(`    멤버 ${Object.keys(project.members).length}명 배정: ${Object.entries(project.members).map(([k, r]) => `${k}=${r}`).join(', ')}`);

  const tasks = await client.get(`/api/projects/${created.id}/tasks/?page_size=100`);
  const taskCount = Array.isArray(tasks) ? tasks.length : (tasks.tasks?.length ?? tasks.count ?? 0);
  log(`    태스크 ${taskCount}건 생성됨`);
  return { id: created.id, taskCount };
};

const main = async () => {
  log(`대상 서버: ${process.env.LS_BASE_URL || 'http://localhost:8080'}`);

  // 계정 id 를 모아 둔다 (프로젝트 멤버 배정에 user id 가 필요).
  const userIdByKey = {};
  for (const account of Object.values(ACCOUNTS)) {
    const client = await clientFor(account);
    userIdByKey[account.key] = client.user.id;
  }
  log(`계정 ${Object.keys(userIdByKey).length}개 로그인 확인`);

  const managers = await managerClients();
  const result = { workspaces: {}, projects: {}, users: userIdByKey };

  for (const ws of Object.values(WORKSPACES)) {
    const client = managers[ws.key];
    const workspace = await findWorkspace(client, ws.title);
    log(`\n워크스페이스 ${workspace.id} ${workspace.title} (매니저 ${ws.manager})`);
    result.workspaces[ws.key] = { id: workspace.id, title: workspace.title, manager: ws.manager };

    await cleanWorkspace(client, workspace.id);

    for (const project of Object.values(PROJECTS).filter((p) => p.workspace === ws.key)) {
      const pool = await createPool(client, workspace.id, project);
      const created = await createProject(client, workspace.id, { ...project, poolId: pool.id }, userIdByKey);
      result.projects[project.key] = {
        id: created.id,
        title: project.title,
        workspace: ws.key,
        workspaceId: workspace.id,
        poolId: pool.id,
        taskCount: created.taskCount,
        reviewStrategy: project.reviewStrategy,
      };
    }
  }

  const outPath = join(dirname(fileURLToPath(import.meta.url)), 'seeded.json');
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  if (jsonOnly) console.log(JSON.stringify(result, null, 2));
  else log(`\n완료. 생성 결과를 ${outPath} 에 기록했습니다.`);
};

main().catch((error) => {
  console.error(`\n시드 실패: ${error.message}`);
  process.exit(1);
});
