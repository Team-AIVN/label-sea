# e2e — 워크스페이스·프로젝트·작업/검수 E2E 테스트

로컬에 떠 있는 LabelSea(`http://localhost:8080`)를 대상으로, **목 계정 11개**로
워크스페이스 2개 / 프로젝트 4개를 만들고 접근 권한과 작업·검수 흐름을 검증합니다.

- 사람이 읽는 테스트 케이스: [docs/01-테스트-케이스.md](docs/01-테스트-케이스.md)
- 발견된 이슈: [docs/02-알려진-이슈.md](docs/02-알려진-이슈.md)

## 준비

서버가 떠 있어야 합니다 (이 폴더는 서버를 띄우지 않습니다).

```bash
docker compose up -d          # 저장소 루트에서
```

처음 한 번만:

```bash
cd e2e
npm install
npx playwright install chromium

npm run seed:accounts         # 계정 11개 가입 (이미 있으면 건너뜀)
npm run seed:bootstrap        # 워크스페이스 2개 생성 + WM1/WM2를 매니저로 지정
```

> `seed:bootstrap`만 `docker compose exec`로 Django 셸을 씁니다.
> 워크스페이스 최초 생성은 super admin이거나 이미 어떤 워크스페이스의 매니저여야 가능한데,
> 목 계정은 그 시작점이 없기 때문입니다. 이후 단계는 전부 공개 REST API로 진행합니다.

## 실행

```bash
npm test                      # 전체 (API + UI). 실행 전에 목 데이터를 자동으로 다시 시드
npm run test:api              # 권한/워크플로 (브라우저 없이 빠르게)
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
│   ├── signup.sh        계정 11개 가입 (/user/signup/ 폼)
│   ├── bootstrap.sh     워크스페이스 생성 + 매니저 지정 (Django 셸, 최초 1회)
│   ├── seed.mjs         작업집합·프로젝트·멤버 배정 (REST API)
│   └── seeded.json      생성 결과 (자동 생성)
├── tests/
│   ├── api/             TC-AC 접근 권한, TC-WF 작업·검수 워크플로
│   └── ui/              TC-UI 화면 조작
├── global-setup.mjs     재시드 + 계정별 로그인 세션 준비
└── playwright.config.js
```

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
