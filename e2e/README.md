# e2e — 워크스페이스·프로젝트·작업/검수 E2E 테스트

로컬에 떠 있는 LabelSea(`http://localhost:8080`)를 대상으로, **목 계정 12개**로
워크스페이스 2개 / 프로젝트 4개를 만들고 접근 권한과 작업·검수 흐름을 검증합니다.

- 사람이 읽는 테스트 케이스: [docs/01-테스트-케이스.md](docs/01-테스트-케이스.md)
- 동작 변경·이슈 기록: [docs/02-알려진-이슈.md](docs/02-알려진-이슈.md)
- **새 기능을 만들 때 쓰는 법**: [아래 챕터](#새-기능을-개발할-때)

## 준비

서버가 떠 있어야 합니다 (이 폴더는 서버를 띄우지 않습니다).

> 기대값은 `develop` 기준입니다. 도커 이미지로 띄운 서버가 `develop`보다 오래됐으면
> 권한·할당 관련 테스트가 실패합니다. 최신 코드를 테스트하려면 아래 "소스 코드로 직접 돌리기"를 쓰세요.

```bash
docker compose up -d          # 저장소 루트에서
```

**소스 코드로 직접 돌리기** (도커 이미지를 다시 굽지 않고 최신 코드를 테스트할 때):

```bash
# 1) 서버 (sqlite, 스크래치 데이터 디렉터리)
cd label_studio
DJANGO_DB=sqlite LABEL_STUDIO_BASE_DATA_DIR=/tmp/ls-data ../.venv/bin/python manage.py migrate
DJANGO_DB=sqlite LABEL_STUDIO_BASE_DATA_DIR=/tmp/ls-data ../.venv/bin/python manage.py runserver 0.0.0.0:8099 --noreload

# 2) 시드 (bootstrap 은 로컬 manage.py 로 돌도록 E2E_LOCAL_MANAGE=1)
bash e2e/seed/signup.sh http://localhost:8099
E2E_LOCAL_MANAGE=1 DJANGO_DB=sqlite LABEL_STUDIO_BASE_DATA_DIR=/tmp/ls-data bash e2e/seed/bootstrap.sh

# 3) 실행
cd e2e && LS_BASE_URL=http://localhost:8099 npm test
```

UI 테스트는 `web/dist` 의 프론트엔드 빌드를 그대로 씁니다. 번들이 오래됐으면 화면 텍스트가
영어로 나오거나 최신 화면이 없어서 실패합니다 — `cd web && yarn run build` 로 다시 빌드하세요.

처음 한 번만:

```bash
cd e2e
npm install
npx playwright install chromium

npm run seed:accounts         # 계정 12개 가입 (이미 있으면 건너뜀)
npm run seed:bootstrap        # 워크스페이스 2개 생성 + WM1/WM2를 매니저로 지정
```

> `seed:bootstrap`만 Django 셸을 씁니다(기본은 `docker compose exec`, `E2E_LOCAL_MANAGE=1`이면 로컬 `.venv`).
> 워크스페이스 최초 생성은 super admin이거나 이미 어떤 워크스페이스의 매니저여야 가능한데,
> 목 계정은 그 시작점이 없기 때문입니다. 이후 단계는 전부 공개 REST API로 진행합니다.

## 실행

```bash
npm test                      # 전체 (API + UI). 실행 전에 목 데이터를 자동으로 다시 시드
npm run test:api              # 권한/워크플로/태스크 할당 (브라우저 없이 빠르게)
npm run test:ui               # 화면 조작
npm run test:headed           # 브라우저를 띄워서 눈으로 보기
npm run report                # 마지막 실행 리포트
```

- `E2E_SKIP_SEED=1`을 붙이면 재시드를 건너뜁니다. 단, 테스트가 태스크를 소비하므로
  같은 데이터로 반복 실행하면 언젠가 태스크가 바닥납니다 (`There are no tasks for ...`). 그때는 다시 시드하세요.
- 대상 서버를 바꾸려면 `LS_BASE_URL=http://... npm test`.

## 목 데이터만 다시 만들기

```bash
npm run seed                  # [E2E] 프로젝트/작업집합을 지우고 새로 생성
```

생성된 id는 `seed/seeded.json`에 기록되고, 테스트는 이 파일을 읽어 대상 프로젝트를 찾습니다.

## 구성

```
e2e/
├── lib/
│   ├── fixtures.mjs     계정·워크스페이스·프로젝트·태스크 정의 (여기만 고치면 시드와 테스트가 함께 바뀜)
│   ├── api.mjs          REST 클라이언트 (세션 로그인 + CSRF)
│   └── auth.mjs         로그인 세션(storageState) 관리
├── seed/
│   ├── signup.sh        계정 12개 가입 (/user/signup/ 폼, admin 먼저)
│   ├── bootstrap.sh     워크스페이스 생성 + 매니저 지정 (Django 셸, 최초 1회)
│   ├── seed.mjs         작업집합·프로젝트·멤버 배정 (REST API)
│   └── seeded.json      생성 결과 (자동 생성)
├── tests/
│   ├── api/             TC-AC 접근 권한, TC-WF 작업·검수 워크플로, TC-TA 태스크 라벨러 할당
│   └── ui/              TC-UI 화면 조작 (탐색 / 라벨링·검수 / 라벨러 할당)
├── global-setup.mjs     재시드 + 계정별 로그인 세션 준비
└── playwright.config.js
```

## 새 기능을 개발할 때

권한·역할이 얽힌 기능(누가 무엇을 보고 바꿀 수 있는가)이나 여러 화면을 가로지르는 흐름을 만들 때
이 스위트를 쓰면 **"내 계정에서는 잘 되는데"** 를 조기에 걸러낼 수 있습니다.
단위 테스트가 함수 하나를 지킨다면, 여기서는 실제 계정으로 로그인해 실제 API·화면을 지납니다.

아래는 `feat/task-assignment`(태스크 라벨러 할당) 때 실제로 따랐던 순서입니다.

### 1. 최신 코드로 서버를 띄운다

도커 이미지를 다시 굽지 않아도 됩니다. 위 "소스 코드로 직접 돌리기"대로 `runserver` + sqlite 로 띄우고
`LS_BASE_URL` 만 바꿔서 돌리면 됩니다. 백엔드만 바뀐 기능이면 이걸로 충분합니다.

### 2. API 동작을 먼저 손으로 확인한다

테스트를 쓰기 전에 **응답을 직접 봐야** 기대값을 지어내지 않습니다.
`lib/api.mjs` 를 그대로 쓰면 로그인·CSRF 처리 없이 몇 줄로 두드려 볼 수 있습니다.

```bash
cd e2e && LS_BASE_URL=http://localhost:8099 node --input-type=module -e "
import { clientFor } from './lib/api.mjs';
import { ACCOUNTS } from './lib/fixtures.mjs';
import { seeded } from './lib/auth.mjs';
const d = seeded();
const pm = await clientFor(ACCOUNTS.pm1);
const res = await pm.raw('POST', '/api/무슨/엔드포인트/', { json: { ... } });
console.log(res.status, JSON.stringify(res.data).slice(0, 300));
"
```

`raw()` 는 4xx/5xx 를 던지지 않고 `{status, data}` 로 돌려줘서 권한 거부 응답을 관찰할 때 좋습니다.

### 3. 필요한 목 데이터를 픽스처에 추가한다

계정·워크스페이스·프로젝트·태스크 정의는 전부 [`lib/fixtures.mjs`](lib/fixtures.mjs) 한 곳에 있습니다.
여기를 고치면 시드와 테스트가 함께 따라옵니다 — 같은 문자열을 두 군데 적지 마세요.

기능이 **새로운 초기 상태**를 요구하면 `seed/seed.mjs` 에 단계를 추가합니다.
예: 라벨러 할당 기능이 들어오면서, 시드가 태스크를 라벨러들에게 나눠 할당하지 않으면
작업자가 태스크를 한 건도 받지 못해 기존 라벨링·검수 시나리오가 전부 무너졌습니다(`assignTasks`).

시드 결과(프로젝트 id, 할당 내역 등)는 `seed/seeded.json` 에 기록되고 테스트가 그걸 읽습니다.
테스트에서 쓸 값이라면 `seed.mjs` 의 `result` 에 담아 두세요.

### 4. API 테스트부터 쓴다

`tests/api/NN-기능이름.spec.js` 로 만듭니다. 규칙:

- **케이스 id를 붙입니다**(`TC-XX-001`). 문서의 표와 1:1로 대응시키기 위해서입니다.
- **권한은 계정별로 한 번씩 훑습니다** — 되는 사람 / 안 되는 사람 / 남의 것. 화면이 아니라 서버 응답으로 확인합니다.
- **상태를 바꾸는 테스트는 전용 프로젝트를 씁니다.** 예를 들어 할당 테스트는 B1만 건드리고,
  라벨링·검수(TC-WF)가 쓰는 A1은 손대지 않습니다. 바꿨으면 끝에서 되돌려 놓습니다.
- 태스크를 소비하는 테스트가 늘면 `fixtures.mjs` 의 `taskCount` 를 올립니다.

```js
import { expect, test } from '@playwright/test';
import { ACCOUNTS } from '../../lib/fixtures.mjs';
import { seeded } from '../../lib/auth.mjs';
import { clientFor } from '../../lib/api.mjs';

const data = seeded();
const clients = {};
const as = async (key) => (clients[key] ??= await clientFor(ACCOUNTS[key]));

test.describe('TC-XX 기능 이름', () => {
  test('TC-XX-001 PM은 할 수 있고 작업자는 못 한다', async () => {
    const allowed = await (await as('pm1')).raw('POST', '...', { json: {} });
    expect(allowed.status).toBe(200);

    const denied = await (await as('annotator1')).raw('POST', '...', { json: {} });
    expect(denied.status).toBe(403);
  });
});
```

### 5. 화면 테스트를 쓴다

프론트엔드가 바뀌었다면 **먼저 빌드**해야 합니다(`cd web && yarn run build`). 안 그러면 오래된 번들을
테스트하게 되어 한국어 문구가 영어로 나오거나 새 화면이 아예 없습니다.

셀렉터는 이 순서로 고릅니다.

1. `data-testid` — 데이터 화면·라벨링 편집기에는 잘 붙어 있습니다(`bottombar-submit-button`, `table-row`).
2. `aria-label` — 툴바·행 체크박스처럼 testid가 없는 곳(`Tasks Actions`, `Select Task <id>`).
3. id·역할·화면 텍스트 — 워크스페이스/프로젝트 화면(`#workspace_name`, `프로젝트 생성`).

그리고 **결과는 API로 다시 확인합니다.** 화면만 보면 버튼이 눌렸는지까지만 알 수 있습니다.

```js
await page.getByTestId('bottombar-accept-button').click();
await expect
  .poll(async () => (await reviewer.get(`/api/tasks/${taskId}/`)).review_status, { timeout: 15_000 })
  .toBe('ACCEPTED');
```

새 화면에 testid가 하나도 없다면, 테스트를 비트는 대신 **제품 코드에 testid를 붙이는 편**이 낫습니다.

### 6. 문서를 갱신하고 전체를 돌린다

- [`docs/01-테스트-케이스.md`](docs/01-테스트-케이스.md) 에 케이스 표를 추가합니다(사람이 읽고 손으로도 따라갈 수 있게).
- 기존 동작이 바뀌었다면 [`docs/02-알려진-이슈.md`](docs/02-알려진-이슈.md) 에 남깁니다.
- 마지막은 항상 시드부터 포함한 전체 실행(`npm test`)입니다. 부분 실행만으로는
  테스트 간 간섭이나 시드 누락을 못 잡습니다.

### 기존 테스트가 깨졌다면

바로 기대값을 고치지 말고, **회귀인지 의도된 사양 변경인지** 먼저 가립니다.

1. 실패한 응답을 직접 확인합니다(2번의 probe).
2. 해당 동작을 만든 커밋·코드를 찾습니다 — `git log -S` 나 백엔드 테스트(`label_studio/**/tests`)가 빠릅니다.
3. 의도된 변경이면 기대값을 고치고, **왜 바뀌었는지 주석과 `docs/02`에 남깁니다.**
   의도치 않은 변경이면 그대로 두고 제품 코드를 고칩니다 — 테스트가 제 역할을 한 것입니다.

실제 예: `feat/task-assignment` 이후 비멤버 응답이 403 → 404로 바뀌었습니다.
`users.rules.visible_projects` 로 조회 범위를 좁힌 의도된 변경이어서 `TC-AC-006`, `TC-AC-009`의 기대값을 갱신했습니다.

### 자주 걸리는 함정

실제로 한 번씩 걸렸던 것들입니다.

| 증상 | 원인 / 대처 |
|---|---|
| 작업자가 태스크를 못 받음 (`There are no tasks for ...`) | 라벨러는 **할당된 태스크만** 봅니다. 시드의 할당 단계를 확인하거나, 테스트가 태스크를 다 써버린 것이니 재시드하세요 |
| 권한 테스트가 통째로 이상함 (작업자에게 다 보임) | 빈 DB에서는 **첫 가입자가 조직 소유자(슈퍼 관리자)** 가 됩니다. `localtest_admin`을 맨 먼저 가입시켜야 합니다 |
| 화면 문구가 영어로 나옴 / 새 화면이 없음 | `web/dist` 번들이 오래된 것입니다. `cd web && yarn run build` |
| API 호출이 401 (`legacy token authentication has been disabled`) | 토큰 인증은 막혀 있습니다. 세션 쿠키 + `X-CSRFToken`을 쓰는 `lib/api.mjs`를 쓰세요 |
| 버튼을 눌렀는데 아무 일도 안 일어남 | 브라우저 기본 `prompt`(예: 거절 사유)일 수 있습니다. Playwright는 대화상자를 자동 취소하므로 `page.on('dialog', ...)` 핸들러가 필요합니다 |
| 커스텀 셀렉트가 `selectOption`으로 안 됨 | 네이티브 `<select>`가 아닙니다. 트리거를 열고 `select-option-<값>`을 클릭하세요. 트리거의 testid에는 **현재 값이 붙습니다**(접두어로 매칭) |
| `strict mode violation` | 같은 텍스트가 여러 곳에 있습니다. testid·aria-label로 좁히거나 `.first()`를 씁니다 |
| 한 태스크에 어노테이션이 여러 개라 검증이 어긋남 | 반려된 태스크는 작업 큐로 돌아옵니다. 인덱스 대신 **어노테이션 id로** 찾으세요 |

### PR 전 체크리스트

- [ ] `npm test` 전체 통과 (시드 포함, 부분 실행 아님)
- [ ] 같은 명령을 **두 번 연속** 돌려도 통과 (상태를 되돌리지 않는 테스트가 있으면 여기서 드러납니다)
- [ ] 새 케이스가 `docs/01-테스트-케이스.md` 표에 있음
- [ ] 기대값을 바꿨다면 이유가 주석/문서에 남아 있음
- [ ] 목 데이터 변경이 `lib/fixtures.mjs` 한 곳에만 있음

## 설계 메모

- **UI 테스트도 결과는 API로 확인합니다.** 화면만 보면 버튼이 눌렸는지까지만 알 수 있고,
  상태가 실제로 바뀌었는지는 서버가 답이기 때문입니다.
- **권한은 API 레벨에서 먼저 검증합니다.** 화면은 메뉴를 숨겨 줄 뿐이라, URL을 직접 치고 들어오는 경우는 서버 응답으로만 확인됩니다.
- **셀렉터**: 데이터 화면·라벨링 편집기에는 `data-testid`가 잘 붙어 있어 그것을 쓰고(`bottombar-submit-button` 등),
  워크스페이스/프로젝트 화면에는 거의 없어서 id(`#workspace_name`)·역할·한국어 텍스트를 씁니다.
  언어 자동감지 때문에 텍스트 셀렉터가 흔들리지 않도록 `playwright.config.js`에서 locale을 `ko-KR`로 고정했습니다.
- **테스트 간 간섭**: 작업·검수 테스트는 매번 `다음 태스크`를 받아 서로 다른 태스크를 건드립니다.
  반려된 태스크는 작업 큐로 돌아와 한 태스크에 어노테이션이 여러 개 쌓일 수 있으므로,
  결과를 확인할 때는 인덱스가 아니라 어노테이션 id로 찾습니다.
