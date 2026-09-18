/**
 * 로그인 세션(storageState) 관리.
 *
 * global-setup 이 계정마다 한 번씩 폼 로그인을 해서 .auth/<key>.json 을 만들고,
 * 각 테스트는 storageState 로 그 파일을 읽어 "그 사람으로" 브라우저를 연다.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ACCOUNTS, BASE_URL } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const AUTH_DIR = join(here, '..', '.auth');
export const SEEDED_PATH = join(here, '..', 'seed', 'seeded.json');

export const storageStatePath = (accountKey) => join(AUTH_DIR, `${accountKey}.json`);

/** seed.mjs 가 남긴 생성 결과(워크스페이스/프로젝트 id). */
export const seeded = () => {
  if (!existsSync(SEEDED_PATH)) {
    throw new Error(`시드 결과가 없습니다: ${SEEDED_PATH}\n먼저 node seed/seed.mjs 를 실행하세요.`);
  }
  return JSON.parse(readFileSync(SEEDED_PATH, 'utf8'));
};

/**
 * 계정 하나로 폼 로그인해 storageState 를 저장한다.
 * @param {import('@playwright/test').APIRequestContext} request
 */
export const mintSession = async (browser, accountKey) => {
  mkdirSync(AUTH_DIR, { recursive: true });
  const account = ACCOUNTS[accountKey];
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();

  await page.goto('/user/login/');
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(account.password);
  await Promise.all([page.waitForURL((url) => !url.pathname.includes('/user/login')), page.locator('button[type="submit"]').click()]);

  await context.storageState({ path: storageStatePath(accountKey) });
  await context.close();
};
