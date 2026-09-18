/**
 * 전체 실행 전 준비:
 *   1) 목 데이터 재시드 (E2E_SKIP_SEED=1 이면 건너뜀)
 *   2) 계정 11개의 로그인 세션을 .auth/ 에 저장
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

import { ACCOUNTS } from './lib/fixtures.mjs';
import { mintSession } from './lib/auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export default async () => {
  if (process.env.E2E_SKIP_SEED !== '1') {
    console.log('[global-setup] 목 데이터 시드 중...');
    const seed = spawnSync(process.execPath, [join(here, 'seed', 'seed.mjs')], { encoding: 'utf8' });
    if (seed.status !== 0) {
      throw new Error(`시드 실패:\n${seed.stdout}\n${seed.stderr}`);
    }
  }

  console.log('[global-setup] 계정 로그인 세션 준비 중...');
  const browser = await chromium.launch();
  try {
    for (const key of Object.keys(ACCOUNTS)) {
      await mintSession(browser, key);
    }
  } finally {
    await browser.close();
  }
  console.log('[global-setup] 준비 완료');
};
