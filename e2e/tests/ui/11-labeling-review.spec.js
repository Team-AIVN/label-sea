/**
 * TC-UI-2xx : 라벨링 화면에서의 작업 수행과 검수 (브라우저)
 *
 * 화면 구조 메모:
 *   - 라벨링 화면은 별도 URL 이 아니라 데이터 매니저의 쿼리 파라미터다.
 *       /projects/<id>/data?labeling=1   → 라벨 스트림(다음 태스크를 계속 받는 모드)
 *       /projects/<id>/data?task=<taskId> → 특정 태스크 열기
 *   - 하단 버튼은 역할에 따라 바뀐다(libs/datamanager sdk 가 role 을 보고 인터페이스를 고름).
 *       작업자 : 제출(bottombar-submit-button) / 건너뛰기(bottombar-skip-button)
 *       검수자 : 승인(bottombar-accept-button) / 거절(bottombar-custom-reject-button)
 *   - 거절은 브라우저 기본 prompt("거절 사유를 입력하세요") 로 사유를 받는다 →
 *     Playwright 는 기본적으로 dialog 를 자동 취소하므로 반드시 핸들러를 달아야 한다.
 *
 * 화면 조작의 결과는 API 로 확인한다. 화면 텍스트만 보면 "눌리기는 했는지"까지만 알 수 있고,
 * 실제로 상태가 바뀌었는지는 서버가 답이기 때문이다.
 */
import { expect, test } from '@playwright/test';

import { ACCOUNTS, choiceResult } from '../../lib/fixtures.mjs';
import { seeded, storageStatePath } from '../../lib/auth.mjs';
import { clientFor } from '../../lib/api.mjs';

const data = seeded();
const A1 = data.projects.a1.id;

const clients = {};
const as = async (key) => (clients[key] ??= await clientFor(ACCOUNTS[key]));

/** 검수 대기(PENDING) 상태의 태스크를 하나 만들어 둔다 (작업자1 이 API 로 제출). */
const givenPendingTask = async () => {
  const annotator = await as('annotator1');
  const task = await annotator.get(`/api/projects/${A1}/next/`);
  const annotation = await annotator.post(`/api/tasks/${task.id}/annotations/`, { result: choiceResult('긍정') });
  return { taskId: task.id, annotationId: annotation.id };
};

/** 서버 상태가 기대값이 될 때까지 기다린다 (UI 조작 → 비동기 저장). */
const expectTaskStatus = async (taskId, status) => {
  const reviewer = await as('reviewer1');
  await expect
    .poll(async () => (await reviewer.get(`/api/tasks/${taskId}/`)).review_status, { timeout: 15_000 })
    .toBe(status);
};

test.describe('TC-UI-2xx 라벨링·검수 화면', () => {
  test.describe('작업자1', () => {
    test.use({ storageState: storageStatePath('annotator1') });

    test('TC-UI-201 라벨 스트림에서 라벨을 골라 제출하면 검수 대기 수가 늘어난다', async ({ page }) => {
      const reviewer = await as('reviewer1');
      const before = await reviewer.get(`/api/projects/${A1}/review/progress/`);

      await page.goto(`/projects/${A1}/data?labeling=1`);
      await expect(page.getByTestId('bottombar-submit-button')).toBeVisible();

      // 라벨을 고른 뒤, 실제로 선택되었는지(라디오 체크) 확인하고 제출한다.
      // 선택이 반영되기 전에 제출하면 "결과 없음"으로 막혀 조용히 아무 일도 일어나지 않는다.
      await page.getByText('긍정', { exact: false }).first().click();
      await expect(page.getByRole('radio', { name: '긍정' })).toBeChecked();

      await page.getByTestId('bottombar-submit-button').click();
      await expect(page.getByText('Annotation saved successfully').first()).toBeVisible();

      await expect
        .poll(async () => (await reviewer.get(`/api/projects/${A1}/review/progress/`)).review_selected, {
          timeout: 20_000,
        })
        .toBe(before.review_selected + 1);
    });

    test('TC-UI-202 작업자 화면에는 검수 버튼(승인/거절)이 없다', async ({ page }) => {
      const { taskId } = await givenPendingTask();
      await page.goto(`/projects/${A1}/data?task=${taskId}`);

      await expect(page.getByTestId('bottombar-accept-button')).toHaveCount(0);
      await expect(page.getByTestId('bottombar-custom-reject-button')).toHaveCount(0);
    });
  });

  test.describe('검수자1', () => {
    test.use({ storageState: storageStatePath('reviewer1') });

    test('TC-UI-203 검수자 화면에는 승인/거절 버튼이 나온다', async ({ page }) => {
      const { taskId } = await givenPendingTask();
      await page.goto(`/projects/${A1}/data?task=${taskId}`);

      await expect(page.getByTestId('bottombar-accept-button')).toHaveText('승인');
      await expect(page.getByTestId('bottombar-custom-reject-button')).toHaveText('거절');
      await expect(page.getByTestId('bottombar-submit-button')).toHaveCount(0);
    });

    test('TC-UI-204 승인 버튼을 누르면 태스크가 승인 상태가 된다', async ({ page }) => {
      const { taskId } = await givenPendingTask();
      await page.goto(`/projects/${A1}/data?task=${taskId}`);

      await page.getByTestId('bottombar-accept-button').click();

      await expectTaskStatus(taskId, 'ACCEPTED');
    });

    test('TC-UI-205 거절 시 사유를 입력받고, 태스크가 반려 상태가 된다', async ({ page }) => {
      const { taskId } = await givenPendingTask();

      // 거절 사유는 브라우저 기본 prompt 로 받는다. 핸들러가 없으면 자동 취소되어 거절이 안 된다.
      let promptMessage = null;
      page.on('dialog', async (dialog) => {
        promptMessage = dialog.message();
        await dialog.accept('라벨이 본문과 맞지 않습니다');
      });

      await page.goto(`/projects/${A1}/data?task=${taskId}`);
      await page.getByTestId('bottombar-custom-reject-button').click();

      await expectTaskStatus(taskId, 'REJECTED');
      expect(promptMessage).toContain('거절 사유');

      // 반려 사유가 검수 이력에 남는다
      const reviewer = await as('reviewer1');
      const rows = await reviewer.get(`/api/projects/${A1}/review/tasks/?task=${taskId}`);
      const comments = rows.flatMap((row) => row.reviews.map((r) => r.comment));
      expect(comments).toContain('라벨이 본문과 맞지 않습니다');
    });

    test('TC-UI-206 검수 내역 화면에서 상태와 진행률을 볼 수 있다', async ({ page }) => {
      const { taskId } = await givenPendingTask();
      await page.goto(`/projects/${A1}/review?task=${taskId}`);

      await expect(page.getByText('작업 내역')).toBeVisible();
      await expect(page.getByText(String(taskId)).first()).toBeVisible();
    });
  });

  test.describe('작업자3 (A1 비멤버)', () => {
    test.use({ storageState: storageStatePath('annotator3') });

    test('TC-UI-207 배정되지 않은 프로젝트의 검수 화면에는 들어갈 수 없다', async ({ page }) => {
      await page.goto(`/projects/${A1}/review`);
      // 역할 가드가 데이터 화면으로 되돌린다 (검수 내역 제목이 보이면 안 된다)
      await expect(page.getByText('작업 내역')).toHaveCount(0);
    });
  });
});
