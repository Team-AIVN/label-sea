/**
 * TC-UI-1xx : 로그인과 워크스페이스/프로젝트 화면 (브라우저)
 *
 * 셀렉터 방침 (화면마다 사정이 다르다):
 *   - 워크스페이스/프로젝트 화면(web/apps/labelstudio)에는 data-testid 가 거의 없다 →
 *     id(#workspace_name 등) · aria-label · 화면 텍스트를 쓴다.
 *   - 화면 텍스트는 한국어다. playwright.config.js 에서 locale 을 ko-KR 로 고정해
 *     언어 자동감지가 흔들리지 않게 했다.
 */
import { expect, test } from '@playwright/test';

import { ACCOUNTS, PROJECTS, WORKSPACES } from '../../lib/fixtures.mjs';
import { seeded, storageStatePath } from '../../lib/auth.mjs';

const data = seeded();

test.describe('TC-UI-1xx 워크스페이스 탐색', () => {
  test('TC-UI-101 목 계정으로 로그인할 수 있다', async ({ page }) => {
    await page.goto('/user/login/');
    await page.locator('#email').fill(ACCOUNTS.wm1.email);
    await page.locator('#password').fill(ACCOUNTS.wm1.password);
    await page.locator('button[type="submit"]').click();

    await expect(page).not.toHaveURL(/\/user\/login/);
    const me = await page.request.get('/api/current-user/whoami').then((r) => r.json());
    expect(me.email).toBe(ACCOUNTS.wm1.email);
  });

  test('TC-UI-102 잘못된 비밀번호는 로그인되지 않는다', async ({ page }) => {
    await page.goto('/user/login/');
    await page.locator('#email').fill(ACCOUNTS.wm1.email);
    await page.locator('#password').fill('wrong-password');
    await page.locator('button[type="submit"]').click();

    await expect(page).toHaveURL(/\/user\/login/);
  });

  test.describe('워크스페이스 매니저(WM1)', () => {
    test.use({ storageState: storageStatePath('wm1') });

    test('TC-UI-103 워크스페이스 목록에서 담당 워크스페이스를 연다', async ({ page }) => {
      await page.goto('/workspaces');
      await expect(page.getByText(WORKSPACES.wsA.title)).toBeVisible();

      await page.goto(`/workspaces/${data.workspaces.wsA.id}`);
      await expect(page.getByText(PROJECTS.a1.title)).toBeVisible();
      await expect(page.getByText(PROJECTS.a2.title)).toBeVisible();
    });

    test('TC-UI-104 워크스페이스 멤버 탭에서 배정된 사람이 보인다', async ({ page }) => {
      await page.goto(`/workspaces/${data.workspaces.wsA.id}?tab=users`);
      // 멤버 표에는 이메일이 아니라 이름이 뜬다 (사용자 / 역할 / 프로젝트 배정 열)
      const table = page.getByRole('table');
      await expect(table).toContainText(ACCOUNTS.wm1.name);
      await expect(table).toContainText(ACCOUNTS.annotator1.name);
      await expect(table).toContainText(ACCOUNTS.reviewer1.name);
      // 워크스페이스 A 에 배정되지 않은 사람은 표에 없다
      await expect(table).not.toContainText(ACCOUNTS.annotator3.name);
    });

    test('TC-UI-105 작업집합(태스크 풀) 탭에서 풀을 고르면 담긴 항목이 보인다', async ({ page }) => {
      await page.goto(`/workspaces/${data.workspaces.wsA.id}?tab=taskpools`);

      // 풀 선택은 <select> 다. 풀 id 로 옵션을 특정해 고른다.
      const poolId = String(data.projects.a1.poolId);
      const select = page.locator(`select:has(option[value="${poolId}"])`);
      await expect(select).toBeVisible();
      await select.selectOption(poolId);

      await expect(page.getByText(`항목 ${PROJECTS.a1.taskCount}개`)).toBeVisible();
      await expect(page.getByText('A1-1', { exact: false }).first()).toBeVisible();
    });
  });

  test.describe('작업자1 (멀티 워크스페이스 배정)', () => {
    test.use({ storageState: storageStatePath('annotator1') });

    test('TC-UI-106 배정된 3개 프로젝트가 목록에 보이고, 미배정 프로젝트는 안 보인다', async ({ page }) => {
      await page.goto('/projects');
      await expect(page.getByText(PROJECTS.a1.title)).toBeVisible();
      await expect(page.getByText(PROJECTS.a2.title)).toBeVisible();
      await expect(page.getByText(PROJECTS.b1.title)).toBeVisible();
      await expect(page.getByText(PROJECTS.b2.title)).toHaveCount(0);
    });
  });

  test.describe('작업자3 (워크스페이스 A 비멤버)', () => {
    test.use({ storageState: storageStatePath('annotator3') });

    test('TC-UI-107 남의 워크스페이스 URL 로 직접 들어가도 내용이 보이지 않는다', async ({ page }) => {
      await page.goto(`/workspaces/${data.workspaces.wsA.id}`);
      // 프로젝트 목록이 노출되지 않아야 한다 (접근 거부 또는 빈 화면/리다이렉트)
      await expect(page.getByText(PROJECTS.a1.title)).toHaveCount(0);
    });

    test('TC-UI-108 배정된 워크스페이스 B 프로젝트만 목록에 보인다', async ({ page }) => {
      await page.goto('/projects');
      await expect(page.getByText(PROJECTS.b1.title)).toBeVisible();
      await expect(page.getByText(PROJECTS.b2.title)).toBeVisible();
      await expect(page.getByText(PROJECTS.a1.title)).toHaveCount(0);
    });
  });
});
