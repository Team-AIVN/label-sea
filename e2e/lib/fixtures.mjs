/**
 * 테스트용 고정 데이터(픽스처) 정의.
 *
 * 시드 스크립트(seed/seed.mjs)와 Playwright 테스트가 모두 이 파일을 import 한다.
 * 여기 값을 바꾸면 시드와 테스트가 함께 따라온다 — 두 곳에 같은 문자열을 적지 말 것.
 */

export const BASE_URL = process.env.LS_BASE_URL || 'http://localhost:8080';

/** 모든 목 계정의 공통 비밀번호. */
export const PASSWORD = 'test1234';

const account = (key, email, name) => ({ key, email, name, password: PASSWORD });

/**
 * 계정 12개. email 은 localtest_{역할}@test.com 규칙을 따른다.
 * (한글은 이메일 로컬파트에 쓸 수 없어 작업자→annotator, 검수자→reviewer 로 표기)
 *
 * admin 은 맨 먼저 가입시킨다: 빈 DB 에서는 첫 가입자가 조직을 만들면서
 * 그 조직의 소유자(= 슈퍼 관리자)가 되기 때문이다. 이 계정을 따로 두지 않으면
 * 작업자1 이 슈퍼 관리자가 되어 권한 테스트의 기준이 통째로 무너진다.
 * 이미 조직이 있는 서버(기존 docker DB 등)에서는 평범한 조직원으로 가입된다 —
 * 슈퍼 관리자 여부에 기대는 테스트는 실행 시점에 확인하고 건너뛴다(isSuperAdmin).
 */
export const ACCOUNTS = {
  admin: account('admin', 'localtest_admin@test.com', '관리자'),
  annotator1: account('annotator1', 'localtest_annotator1@test.com', '작업자1'),
  annotator2: account('annotator2', 'localtest_annotator2@test.com', '작업자2'),
  annotator3: account('annotator3', 'localtest_annotator3@test.com', '작업자3'),
  reviewer1: account('reviewer1', 'localtest_reviewer1@test.com', '검수자1'),
  reviewer2: account('reviewer2', 'localtest_reviewer2@test.com', '검수자2'),
  pm1: account('pm1', 'localtest_pm1@test.com', 'PM1'),
  pm2: account('pm2', 'localtest_pm2@test.com', 'PM2'),
  pm3: account('pm3', 'localtest_pm3@test.com', 'PM3'),
  pm4: account('pm4', 'localtest_pm4@test.com', 'PM4'),
  wm1: account('wm1', 'localtest_wm1@test.com', 'WM1'),
  wm2: account('wm2', 'localtest_wm2@test.com', 'WM2'),
};

/** 감성 분류 라벨 설정 — 모든 목 프로젝트가 같은 설정을 쓴다. */
export const LABEL_CONFIG = `<View>
  <Text name="text" value="$text"/>
  <Choices name="sentiment" toName="text" choice="single-radio">
    <Choice value="긍정"/>
    <Choice value="부정"/>
    <Choice value="중립"/>
  </Choices>
</View>`;

/** 라벨링 결과 한 건을 만드는 헬퍼 (API 로 어노테이션을 넣을 때 사용). */
export const choiceResult = (choice) => [
  {
    from_name: 'sentiment',
    to_name: 'text',
    type: 'choices',
    value: { choices: [choice] },
  },
];

const SAMPLE_TEXTS = [
  '배송이 빨라서 좋았어요',
  '품질이 기대에 못 미칩니다',
  '그냥 무난한 제품입니다',
  '두 번째 구매인데 여전히 만족',
  '포장이 찢어져서 왔습니다',
  '가격 대비 괜찮은 편이에요',
];

/**
 * 프로젝트별 태스크 원본 데이터.
 * count 는 프로젝트마다 다르다 — 검수 시나리오를 여러 번 도는 A1 은 태스크가 더 필요하다.
 */
export const taskTexts = (prefix, count) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i + 1} ${SAMPLE_TEXTS[i % SAMPLE_TEXTS.length]}`);

/**
 * 워크스페이스 2개. manager 는 부트스트랩 단계에서 workspace_manager 로 지정된다.
 * (워크스페이스 최초 생성은 super admin/기존 workspace manager 만 가능해서
 *  seed/bootstrap.sh 가 DB 레벨에서 만들어 준다 — README 참고)
 */
export const WORKSPACES = {
  wsA: {
    key: 'wsA',
    title: '[E2E] 워크스페이스 A',
    description: 'E2E 목 데이터 — 텍스트 감성 분류 운영 조직',
    manager: 'wm1',
  },
  wsB: {
    key: 'wsB',
    title: '[E2E] 워크스페이스 B',
    description: 'E2E 목 데이터 — 검수 파일럿 운영 조직',
    manager: 'wm2',
  },
};

/**
 * 프로젝트 4개 (워크스페이스당 2개).
 *
 * members: 프로젝트 멤버로 등록할 계정과 역할.
 *   project_manager / annotator / reviewer (users/constants.py ProjectRole)
 * reviewStrategy: NONE | RANDOM_SAMPLING | FULL_REVIEW
 *   FULL_REVIEW = 제출된 어노테이션이 전부 검수 대상(PENDING)으로 선택됨 → 검수 테스트에 사용
 */
export const PROJECTS = {
  a1: {
    key: 'a1',
    workspace: 'wsA',
    title: '[E2E] A1 감성 분류 (전수 검수)',
    description: '작업자1·작업자2 작업, 검수자1 검수. 검수 워크플로 주 시나리오.',
    reviewStrategy: 'FULL_REVIEW',
    reviewRatio: 0,
    poolTitle: '[E2E] A1 태스크 풀',
    // API 시나리오 8건 + UI 시나리오 6건이 각자 새 태스크를 소비한다. 넉넉히 둔다.
    textPrefix: 'A1',
    taskCount: 40,
    members: {
      pm1: 'project_manager',
      annotator1: 'annotator',
      annotator2: 'annotator',
      reviewer1: 'reviewer',
    },
  },
  a2: {
    key: 'a2',
    workspace: 'wsA',
    title: '[E2E] A2 감성 분류 (표본 검수)',
    description: '작업자1 재배정(멀티 프로젝트), 검수자1 멀티 프로젝트 검수.',
    reviewStrategy: 'RANDOM_SAMPLING',
    reviewRatio: 0.5,
    poolTitle: '[E2E] A2 태스크 풀',
    textPrefix: 'A2',
    taskCount: 6,
    members: {
      pm2: 'project_manager',
      annotator1: 'annotator',
      reviewer1: 'reviewer',
    },
  },
  b1: {
    key: 'b1',
    workspace: 'wsB',
    title: '[E2E] B1 감성 분류 (전수 검수)',
    description: '작업자1 이 워크스페이스를 넘나들며 배정된 프로젝트.',
    reviewStrategy: 'FULL_REVIEW',
    reviewRatio: 0,
    poolTitle: '[E2E] B1 태스크 풀',
    textPrefix: 'B1',
    taskCount: 8,
    members: {
      pm3: 'project_manager',
      annotator1: 'annotator',
      annotator3: 'annotator',
      reviewer2: 'reviewer',
    },
  },
  b2: {
    key: 'b2',
    workspace: 'wsB',
    title: '[E2E] B2 감성 분류 (검수 없음)',
    description: '검수 전략 NONE — 검수 대상으로 선택되지 않는 경우 비교군.',
    reviewStrategy: 'NONE',
    reviewRatio: 0,
    poolTitle: '[E2E] B2 태스크 풀',
    textPrefix: 'B2',
    taskCount: 6,
    members: {
      pm4: 'project_manager',
      annotator3: 'annotator',
      reviewer2: 'reviewer',
    },
  },
};

/**
 * 접근 권한 테스트의 기대값 기준표.
 * "이 계정이 이 워크스페이스/프로젝트의 멤버인가" 를 한 곳에서 계산한다.
 */
export const projectsOf = (accountKey) =>
  Object.values(PROJECTS).filter((p) => Boolean(p.members[accountKey]));

export const workspacesOf = (accountKey) => {
  const keys = new Set();
  for (const p of projectsOf(accountKey)) keys.add(p.workspace);
  for (const ws of Object.values(WORKSPACES)) if (ws.manager === accountKey) keys.add(ws.key);
  return [...keys].map((k) => WORKSPACES[k]);
};

export const isMemberOfWorkspace = (accountKey, workspaceKey) =>
  workspacesOf(accountKey).some((ws) => ws.key === workspaceKey);
