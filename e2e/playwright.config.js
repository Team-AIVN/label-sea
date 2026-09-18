import { defineConfig, devices } from '@playwright/test';

import { BASE_URL } from './lib/fixtures.mjs';

/**
 * 테스트는 이미 떠 있는 개발 서버(docker compose)를 대상으로 돈다.
 * 서버를 띄우는 일은 이 설정의 책임이 아니다 — README 참고.
 *
 * globalSetup 이 매 실행마다
 *   1) 목 데이터를 다시 시드하고(프로젝트/태스크를 새로 만들어 상태를 초기화)
 *   2) 계정 11개의 로그인 세션(storageState)을 .auth/ 에 저장한다.
 * 시드를 건너뛰려면 E2E_SKIP_SEED=1.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.mjs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // 같은 목 데이터를 공유하므로 순차 실행
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // 한국어 UI 를 강제한다 — 텍스트 셀렉터가 언어에 따라 흔들리지 않도록.
    locale: 'ko-KR',
  },
  projects: [
    {
      name: 'api',
      testDir: './tests/api',
    },
    {
      name: 'ui',
      testDir: './tests/ui',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
