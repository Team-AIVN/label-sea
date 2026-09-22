/**
 * TC-UI-3xx : 태스크 라벨러 할당 화면 (feat/task-assignment)
 *
 * 화면 구조 메모:
 *   - 할당은 Data Manager 툴바의 "작업"(Tasks Actions) 메뉴에서 한다.
 *     그 버튼에는 testid 가 없고 `aria-label="Tasks Actions"` 가 붙어 있다.
 *     행을 하나도 고르지 않으면 disabled 라서, 먼저 행 체크박스를 선택해야 한다.
 *   - 메뉴 항목 이름("라벨러 할당" / "라벨러 할당 해제")과 다이얼로그 문구는 **백엔드**가 내려준다
 *     (data_manager/actions/assign.py). 프론트 번들이 아니라 서버 문구가 기준이다.
 *   - 라벨러 선택은 커스텀 셀렉트 위젯이다. 네이티브 <select> 가 아니라서 selectOption 이
 *     통하지 않는다 — 트리거를 열고 `select-option-<사용자id>` 항목을 클릭한다.
 *     트리거의 testid 에는 현재 값이 붙는다(고르기 전 `select-trigger-labeler`,
 *     고른 뒤 `select-trigger-labeler-<사용자id>`) → 접두어 매칭으로 잡는다.
 *   - 확인 버튼은 글자가 "OK" 지만 접근성 이름은 "Confirm" 이다.
 *   - 라벨러 컬럼은 컬럼 선택기의 `col:tasks:labeler` 로 존재를 확인한다.
 *   - 라벨러 셀은 이름 텍스트가 아니라 **아바타**로 그려진다(`[data-testid=userpic]`,
 *     `img[alt="<이름>"]`, 화면에는 이니셜만 노출). 그래서 이름으로 찾을 때는 alt 를 본다.
 *   - 행 체크박스에는 `aria-label="Select Task <태스크id>"` 가 붙어 있어 특정 행을 정확히 고를 수 있다.
 *
 * 화면 조작의 결과는 API 로 확인한다 — 화면 표시만으로는 서버 상태가 바뀌었는지 알 수 없다.
 */
import { expect, test } from '@playwright/test';

import { ACCOUNTS } from '../../lib/fixtures.mjs';
import { seeded, storageStatePath } from '../../lib/auth.mjs';
import { clientFor } from '../../lib/api.mjs';

const data = seeded();
const B1 = data.projects.b1.id;

const clients = {};
const as = async (key) => (clients[key] ??= await clientFor(ACCOUNTS[key]));

/** 서버 기준으로 그 라벨러에게 할당된 태스크 id 목록. */
const assignedTaskIds = async (accountKey) => {
  const client = await as(accountKey);
  const { tasks } = await client.get(`/api/tasks/?project=${B1}&page_size=1000`);
  return tasks.map((t) => t.id).sort((a, b) => a - b);
};

/** 특정 태스크 행을 선택한다. */
const selectTaskRow = async (page, taskId) => {
  await expect(page.getByTestId('table-row').first()).toBeVisible();
  await page.locator(`input[aria-label="Select Task ${taskId}"]`).click({ force: true });
};

/** DM 툴바의 "작업" 메뉴를 연다 (행을 하나 선택해야 활성화된다). */
const openActionsMenu = async (page, taskId) => {
  if (taskId) await selectTaskRow(page, taskId);
  else {
    await expect(page.getByTestId('table-row').first()).toBeVisible();
    await page.locator('input[type=checkbox]').nth(1).click({ force: true });
  }
  const actions = page.locator('button[aria-label="Tasks Actions"]');
  await expect(actions).toBeEnabled();
  await actions.click();
};

/**
 * 확인 다이얼로그의 OK 를 누른다.
 * 버튼에 보이는 글자는 "OK" 지만 접근성 이름은 aria-label 의 "Confirm" 이라
 * getByRole('button', { name: 'OK' }) 로는 잡히지 않는다.
 */
const confirmDialog = (page) => page.locator('button[aria-label="Confirm"]').click();

/** 태스크 행의 라벨러 아바타 (이름은 alt 로만 드러난다). */
const labelerAvatar = (page, taskId, name) =>
  page
    .getByTestId('table-row-wrapper')
    .filter({ hasText: String(taskId) })
    .first()
    .locator(`img[alt="${name}"]`);

test.describe('TC-UI-3xx 라벨러 할당 화면', () => {
  test.describe('PM3', () => {
    test.use({ storageState: storageStatePath('pm3') });

    test('TC-UI-301 데이터 화면에 라벨러 컬럼이 있고 담당자가 표시된다', async ({ page }) => {
      // 이 테스트는 시드가 배정해 둔 상태를 읽기만 한다. 앞선 테스트가 배정을 바꿔도
      // 흔들리지 않도록, 확인 대상 태스크는 서버에서 직접 고른다.
      const annotator1 = await as('annotator1');
      const { tasks } = await annotator1.get(`/api/tasks/?project=${B1}&page_size=1`);
      const assignedTask = tasks[0].id;

      await page.goto(`/projects/${B1}/data`);
      await expect(page.getByTestId('table-row').first()).toBeVisible();

      // 컬럼 선택기에 labeler 컬럼이 등록되어 있다
      await expect(page.locator('[data-testid*="col:tasks:labeler"]')).toHaveCount(1);
      // 표 헤더에도 라벨러 열이 보인다
      await expect(page.getByText('라벨러', { exact: true }).first()).toBeVisible();
      // 배정된 행에는 라벨러 아바타가 뜬다 (이름은 alt 에 들어간다)
      await expect(labelerAvatar(page, assignedTask, ACCOUNTS.annotator1.name)).toHaveCount(1);
    });

    test('TC-UI-302 작업 메뉴에 라벨러 할당·해제가 있다', async ({ page }) => {
      await page.goto(`/projects/${B1}/data`);
      await openActionsMenu(page);

      await expect(page.getByText('라벨러 할당', { exact: true })).toBeVisible();
      await expect(page.getByText('라벨러 할당 해제', { exact: true })).toBeVisible();
    });

    test('TC-UI-303 PM 은 프로젝트의 모든 태스크를 본다', async ({ page }) => {
      await page.goto(`/projects/${B1}/data`);
      await expect(page.getByTestId('table-row')).toHaveCount(data.projects.b1.taskCount);
    });

    test('TC-UI-304 화면에서 할당을 해제하면 라벨러의 목록에서 빠진다', async ({ page }) => {
      const before = await assignedTaskIds('annotator1');
      expect(before.length).toBeGreaterThan(0);

      await page.goto(`/projects/${B1}/data`);
      // 작업자1 의 태스크 한 건을 골라 해제한다
      const target = before[0];
      await selectTaskRow(page, target);

      await page.locator('button[aria-label="Tasks Actions"]').click();
      await page.getByText('라벨러 할당 해제', { exact: true }).click();
      await confirmDialog(page);

      await expect
        .poll(async () => (await assignedTaskIds('annotator1')).includes(target), { timeout: 15_000 })
        .toBe(false);

      // 뒷정리: 원래 주인에게 돌려준다
      const pm3 = await as('pm3');
      await pm3.post(`/api/dm/actions/?id=assign_tasks&project=${B1}`, {
        selectedItems: { all: false, included: [target] },
        labeler: String(data.users.annotator1),
      });
    });

    test('TC-UI-305 화면에서 라벨러를 골라 할당하면 그 라벨러에게 보인다', async ({ page }) => {
      // TC-UI-304 가 해제해 둔 태스크를 다시 할당한다 (해제되어 있지 않으면 여기서 해제한다)
      const target = data.projects.b1.assignments.annotator1.taskIds[0];
      const pm3 = await as('pm3');
      await pm3.raw('POST', `/api/dm/actions/?id=unassign_tasks&project=${B1}`, {
        json: { selectedItems: { all: false, included: [target] } },
      });

      await page.goto(`/projects/${B1}/data`);
      await selectTaskRow(page, target);

      await page.locator('button[aria-label="Tasks Actions"]').click();
      await page.getByText('라벨러 할당', { exact: true }).first().click();

      // 라벨러 선택은 네이티브 <select> 가 아니라 커스텀 위젯이다:
      // 트리거(`select-trigger-labeler`)를 열고 이름으로 고른다.
      // 트리거의 testid 에는 현재 값이 붙는다: 고르기 전 `select-trigger-labeler`,
      // 고른 뒤 `select-trigger-labeler-<사용자id>`. 그래서 접두어로 잡아야 선택 전후 모두 가리킨다.
      const trigger = page.locator('[data-testid^="select-trigger-labeler"]');
      await expect(trigger).toBeVisible();
      await trigger.click();
      // 옵션의 testid 는 select-option-<사용자id> 라 이름 중복 걱정 없이 정확히 고를 수 있다
      await page.getByTestId(`select-option-${data.users.annotator1}`).click();
      await expect(trigger).toHaveText(ACCOUNTS.annotator1.name);

      await confirmDialog(page);

      await expect
        .poll(async () => (await assignedTaskIds('annotator1')).includes(target), { timeout: 15_000 })
        .toBe(true);
    });
  });

  test.describe('작업자1', () => {
    test.use({ storageState: storageStatePath('annotator1') });

    test('TC-UI-306 라벨러 화면에는 자기 태스크만 보이고 할당 메뉴가 없다', async ({ page }) => {
      const mine = await assignedTaskIds('annotator1');

      await page.goto(`/projects/${B1}/data`);
      await expect(page.getByTestId('table-row')).toHaveCount(mine.length);
      expect(mine.length).toBeLessThan(data.projects.b1.taskCount);

      // 할당 액션 자체가 제공되지 않는다
      await page.locator('input[type=checkbox]').nth(1).click({ force: true });
      const actions = page.locator('button[aria-label="Tasks Actions"]');
      if (await actions.count()) {
        await actions.click();
        await expect(page.getByText('라벨러 할당', { exact: true })).toHaveCount(0);
      }
    });
  });
});
