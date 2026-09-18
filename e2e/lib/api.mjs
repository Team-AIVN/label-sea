/**
 * LabelSea REST API 클라이언트 (시드 스크립트 + API 레벨 테스트 공용).
 *
 * 인증: /user/login/ 에 Django 폼 로그인 → 세션 쿠키(sessionid, csrftoken)를 그대로 재사용한다.
 * 쓰기 요청에는 `X-CSRFToken` 헤더와 `Referer` 를 함께 보낸다.
 * (레거시 토큰 인증 `Authorization: Token ...` 은 이 배포에서 비활성화되어 있어 쓸 수 없다 —
 *  /api/current-user/token 이 토큰을 주긴 하지만 사용 시 401 "legacy token authentication has been disabled".)
 */
import { BASE_URL } from './fixtures.mjs';

class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → HTTP ${status}\n${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Set-Cookie 헤더에서 쿠키를 모아 두는 최소 쿠키 자(jar). */
const parseCookies = (res, jar) => {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
};

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

export class ApiClient {
  /**
   * @param {{email: string, password: string, name?: string}} account
   * @param {string} [baseUrl]
   */
  constructor(account, baseUrl = BASE_URL) {
    this.account = account;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.jar = new Map();
    this.token = null;
    this.user = null;
  }

  async login() {
    const loginUrl = `${this.baseUrl}/user/login/`;
    const page = await fetch(loginUrl, { redirect: 'manual' });
    parseCookies(page, this.jar);
    const html = await page.text();
    const csrf = /name="csrfmiddlewaretoken" value="([^"]+)"/.exec(html)?.[1];
    if (!csrf) throw new Error('로그인 폼에서 CSRF 토큰을 찾지 못했습니다. 서버가 떠 있는지 확인하세요.');

    const body = new URLSearchParams({
      csrfmiddlewaretoken: csrf,
      email: this.account.email,
      password: this.account.password,
      persist_session: 'on',
    });
    const res = await fetch(loginUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(this.jar),
        Referer: loginUrl,
      },
      body,
    });
    parseCookies(res, this.jar);
    if (res.status !== 302) {
      throw new Error(`로그인 실패: ${this.account.email} (HTTP ${res.status}) — 비밀번호/계정 존재 여부를 확인하세요.`);
    }

    this.user = await this.get('/api/current-user/whoami');
    return this;
  }

  async request(method, path, { json, formData, expect } = {}) {
    const headers = {
      Cookie: cookieHeader(this.jar),
      'X-CSRFToken': this.jar.get('csrftoken') ?? '',
      Referer: `${this.baseUrl}/`,
    };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (formData) {
      body = formData;
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, redirect: 'manual' });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* HTML 오류 페이지 등은 문자열 그대로 둔다 */
    }
    if (expect === 'any') {
      /* 상태코드 검사를 하지 않는다 (권한 테스트에서 403/404 를 값으로 다룰 때) */
    } else if (expect !== undefined) {
      const allowed = Array.isArray(expect) ? expect : [expect];
      if (!allowed.includes(res.status)) throw new ApiError(method, path, res.status, parsed);
    } else if (res.status >= 400) {
      throw new ApiError(method, path, res.status, parsed);
    }
    return { status: res.status, data: parsed };
  }

  /** 상태코드 검사 없이 `{status, data}` 를 돌려준다 (403/404 를 기대하는 권한 테스트용). */
  raw(method, path, options = {}) {
    return this.request(method, path, { ...options, expect: 'any' });
  }

  async get(path) {
    return (await this.request('GET', path)).data;
  }
  async post(path, json) {
    return (await this.request('POST', path, { json })).data;
  }
  async patch(path, json) {
    return (await this.request('PATCH', path, { json })).data;
  }
  async del(path) {
    return (await this.request('DELETE', path, { expect: [200, 204] })).data;
  }

  /** 워크스페이스에 JSON 태스크 파일을 업로드한다 (→ TaskSourceItem 생성). */
  async uploadTasks(workspaceId, filename, tasks) {
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(tasks)], { type: 'application/json' }), filename);
    return (await this.request('POST', `/api/workspaces/${workspaceId}/file-uploads/`, { formData: form })).data;
  }
}

/** 계정으로 로그인한 클라이언트를 만든다. */
export const clientFor = (account, baseUrl) => new ApiClient(account, baseUrl).login();

export { ApiError };
