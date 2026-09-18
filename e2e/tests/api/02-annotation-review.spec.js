/**
 * TC-WF-* : 작업(라벨링) → 검수 워크플로 (API 레벨)
 *
 * 상태 전이 (reviews/services.py):
 *   제출        → Task.review_status = PENDING        (검수 전략 FULL_REVIEW 기준)
 *   ACCEPT      → ACCEPTED,            Annotation.status = APPROVED
 *   REJECT      → REJECTED,            status = REWORK_REQUIRED, is_labeled=False (작업자 큐로 복귀)
 *   작업자 재제출 → 다시 PENDING        (RESUBMITTED 활동 기록)
 *   FIX_AND_ACCEPT → FIXED_AND_ACCEPTED, 검수자가 결과를 직접 고치고 승인(변경 요약이 comment 로 남음)
 *
 * 각 테스트는 /api/projects/<id>/next/ 로 "아직 라벨링되지 않은 태스크"를 받아 쓰므로
 * 서로 다른 태스크를 건드린다 — 실행 순서에 의존하지 않는다.
 */
import { expect, test } from '@playwright/test';

import { ACCOUNTS, choiceResult } from '../../lib/fixtures.mjs';
import { seeded } from '../../lib/auth.mjs';
import { clientFor } from '../../lib/api.mjs';

const data = seeded();
const A1 = data.projects.a1.id; // FULL_REVIEW
const B2 = data.projects.b2.id; // 검수 전략 NONE

const clients = {};
const as = async (key) => (clients[key] ??= await clientFor(ACCOUNTS[key]));

/**
 * 태스크 상세에서 특정 어노테이션을 id 로 찾는다.
 * 인덱스로 집으면 안 되는 이유: 반려된 태스크는 작업 큐로 돌아오므로 한 태스크에
 * 어노테이션이 여러 건 쌓일 수 있다(앞 테스트가 반려한 태스크를 뒤 테스트가 다시 받는다).
 */
const annotationOf = (task, annotationId) => {
  const found = task.annotations.find((a) => a.id === annotationId);
  if (!found) throw new Error(`태스크 ${task.id} 에서 어노테이션 ${annotationId} 을 찾지 못했습니다`);
  return found;
};

/** 라벨링되지 않은 다음 태스크를 받아 어노테이션 한 건을 제출한다. */
const submitAnnotation = async (accountKey, projectId, choice) => {
  const client = await as(accountKey);
  const task = await client.get(`/api/projects/${projectId}/next/`);
  const annotation = await client.post(`/api/tasks/${task.id}/annotations/`, {
    result: choiceResult(choice),
    was_cancelled: false,
    lead_time: 3,
  });
  return { task, annotation, client };
};

test.describe('TC-WF 작업·검수 수행', () => {
  test('TC-WF-001 작업자가 제출하면 태스크가 검수 대기(PENDING)로 넘어간다', async () => {
    const { task, annotation, client } = await submitAnnotation('annotator1', A1, '긍정');
    expect(annotation.status).toBe('COMPLETED');
    expect(annotation.version).toBe(1);

    const after = await client.get(`/api/tasks/${task.id}/`);
    expect(after.review_status).toBe('PENDING');
    expect(after.is_labeled).toBe(true);
    expect(after.current_annotation).toBe(annotation.id);
  });

  test('TC-WF-002 제출한 작업이 검수자의 검수 대상 목록에 올라온다', async () => {
    const { task, annotation } = await submitAnnotation('annotator2', A1, '부정');

    const reviewer = await as('reviewer1');
    const candidates = await reviewer.get(`/api/projects/${A1}/review/candidates/`);
    const mine = candidates.find((c) => c.task_id === task.id);
    expect(mine, '검수 대상 목록에 방금 제출한 태스크가 있어야 한다').toBeTruthy();
    expect(mine.current_annotation_id).toBe(annotation.id);
    expect(mine.annotator.email).toBe(ACCOUNTS.annotator2.email);
    expect(mine.review_status).toBe('PENDING');
  });

  test('TC-WF-003 검수자가 승인하면 ACCEPTED / APPROVED 가 된다', async () => {
    const { task, annotation } = await submitAnnotation('annotator1', A1, '중립');

    const reviewer = await as('reviewer1');
    const review = await reviewer.post(`/api/annotations/${annotation.id}/review/`, {
      decision: 'ACCEPT',
      comment: '라벨 정확합니다',
    });
    expect(review.decision).toBe('ACCEPT');
    expect(review.reviewer).toBe(data.users.reviewer1);

    const after = await reviewer.get(`/api/tasks/${task.id}/`);
    expect(after.review_status).toBe('ACCEPTED');
    expect(annotationOf(after, annotation.id).status).toBe('APPROVED');
    expect(after.reviewed_by).toContain(data.users.reviewer1);
  });

  test('TC-WF-004 검수자가 반려하면 작업자 큐로 돌아간다', async () => {
    const { task, annotation } = await submitAnnotation('annotator1', A1, '긍정');

    const reviewer = await as('reviewer1');
    const review = await reviewer.post(`/api/annotations/${annotation.id}/review/`, {
      decision: 'REJECT',
      comment: '감정 라벨이 본문과 맞지 않습니다',
    });
    expect(review.decision).toBe('REJECT');

    const after = await reviewer.get(`/api/tasks/${task.id}/`);
    expect(after.review_status).toBe('REJECTED');
    expect(after.is_labeled, '반려되면 다시 작업 대상이 된다').toBe(false);
    expect(annotationOf(after, annotation.id).status).toBe('REWORK_REQUIRED');
  });

  test('TC-WF-005 반려된 작업을 작업자가 수정하면 다시 검수 대기가 된다', async () => {
    const { task, annotation, client: annotator } = await submitAnnotation('annotator1', A1, '긍정');
    const reviewer = await as('reviewer1');
    await reviewer.post(`/api/annotations/${annotation.id}/review/`, { decision: 'REJECT', comment: '다시 봐주세요' });

    await annotator.patch(`/api/annotations/${annotation.id}/`, { result: choiceResult('부정') });

    const after = await reviewer.get(`/api/tasks/${task.id}/`);
    expect(after.review_status).toBe('PENDING');
    expect(annotationOf(after, annotation.id).status).toBe('COMPLETED');
    // 재제출 이력이 활동 기록에 남는다
    const decisions = after.reviews.map((r) => r.decision);
    expect(decisions).toContain('REJECT');
  });

  test('TC-WF-006 검수자가 직접 고쳐서 승인하면 FIXED_AND_ACCEPTED 와 변경 요약이 남는다', async () => {
    const { task, annotation } = await submitAnnotation('annotator2', A1, '부정');

    const reviewer = await as('reviewer1');
    const review = await reviewer.post(`/api/annotations/${annotation.id}/review/`, {
      decision: 'FIX_AND_ACCEPT',
      content: choiceResult('긍정'),
    });
    expect(review.decision).toBe('FIX_AND_ACCEPT');
    expect(review.comment, '무엇을 고쳤는지 자동 요약이 붙는다').toContain('부정 → 긍정');

    const after = await reviewer.get(`/api/tasks/${task.id}/`);
    expect(after.review_status).toBe('FIXED_AND_ACCEPTED');
    expect(annotationOf(after, annotation.id).status).toBe('APPROVED');
    expect(annotationOf(after, annotation.id).result[0].value.choices).toEqual(['긍정']);
  });

  test('TC-WF-007 FIX_AND_ACCEPT 는 수정 내용(content) 없이는 거부된다 (400)', async () => {
    const { annotation } = await submitAnnotation('annotator1', A1, '중립');
    const reviewer = await as('reviewer1');
    const res = await reviewer.raw('POST', `/api/annotations/${annotation.id}/review/`, {
      json: { decision: 'FIX_AND_ACCEPT' },
    });
    expect(res.status).toBe(400);
  });

  test('TC-WF-008 검수 전략 NONE 프로젝트는 제출해도 검수 대상이 되지 않는다', async () => {
    const { task, client } = await submitAnnotation('annotator3', B2, '긍정');
    const after = await client.get(`/api/tasks/${task.id}/`);
    expect(after.review_status).toBe('NOT_SELECTED');
  });

  test('TC-WF-009 검수 진행률이 작업/검수 결과를 반영한다', async () => {
    const reviewer = await as('reviewer1');
    const before = await reviewer.get(`/api/projects/${A1}/review/progress/`);

    const { annotation } = await submitAnnotation('annotator1', A1, '긍정');
    const mid = await reviewer.get(`/api/projects/${A1}/review/progress/`);
    expect(mid.review_selected, '제출하면 검수 대상 수가 늘어난다').toBe(before.review_selected + 1);

    await reviewer.post(`/api/annotations/${annotation.id}/review/`, { decision: 'ACCEPT' });
    const after = await reviewer.get(`/api/projects/${A1}/review/progress/`);
    expect(after.review_completed).toBe(mid.review_completed + 1);
    expect(after.total_tasks).toBe(data.projects.a1.taskCount);
  });

  test('TC-WF-010 검수 이력 조회는 상태별로 필터할 수 있다', async () => {
    const reviewer = await as('reviewer1');
    const accepted = await reviewer.get(`/api/projects/${A1}/review/tasks/?review_status=ACCEPTED`);
    for (const row of accepted) expect(row.review_status).toBe('ACCEPTED');

    const invalid = await reviewer.raw('GET', `/api/projects/${A1}/review/tasks/?review_status=존재하지않음`);
    expect(invalid.status).toBe(400);
  });
});
