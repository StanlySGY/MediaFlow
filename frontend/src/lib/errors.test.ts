import { describe, it, expect } from 'vitest';
import { ApiError, errorMessage, parseRetryAfterMs, responseError } from './errors';

const fakeResponse = (body: string, status = 503): Response =>
  ({ text: async () => body, status } as unknown as Response);

describe('errorMessage', () => {
  it('prefers Error.message over String()', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('responseError', () => {
  it('unwraps FastAPI {"detail": "..."} so the sentence survives', async () => {
    const err = await responseError(
      fakeResponse('{"detail":"同时录音已达上限（4 路），请等待他人结束录音后重试"}'),
    );
    expect(err.message).toBe('同时录音已达上限（4 路），请等待他人结束录音后重试');
  });

  it('keeps non-JSON bodies verbatim', async () => {
    const err = await responseError(fakeResponse('gateway blew up'));
    expect(err.message).toBe('gateway blew up');
  });

  it('falls back to the status code when the body is empty', async () => {
    const err = await responseError(fakeResponse('', 429));
    expect(err.message).toBe('HTTP 429');
  });

  it('falls back to the raw body when structured detail has no message', async () => {
    const err = await responseError(fakeResponse('{"detail":{"code":7}}', 500));
    expect(err.message).toBe('{"detail":{"code":7}}');
  });

  it('shows structured detail.message and appends hint', async () => {
    const err = await responseError(
      fakeResponse(
        '{"detail":{"code":"session_limit","message":"同时录音已达上限","hint":"请等待他人结束录音后重试","retryable":true}}',
        503,
      ),
    );
    expect(err.message).toBe('同时录音已达上限（请等待他人结束录音后重试）');
  });
});

// The whole protocol arrives through responseError, so the helper is the pair:
// a Response shaped like FastAPI's, turned into the ApiError the panel reads.
const structuredError = (
  detail: Record<string, unknown>,
  status = 429,
  headers: Record<string, string> = {},
): Promise<ApiError> =>
  responseError(({
    text: async () => JSON.stringify({ detail }),
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response));

describe('parseRetryAfterMs', () => {
  it('converts the delta-seconds form the gateway sends', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(' 15 ')).toBe(15000);
  });
  it('reports no hint for anything it cannot turn into a wait', () => {
    // The HTTP-date form is not worth a Date.parse here; the caller's own
    // backoff is a better guess than a misparsed one.
    expect(parseRetryAfterMs('Sun, 25 Oct 2026 12:00:00 GMT')).toBeNull();
    expect(parseRetryAfterMs('-1')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
  });
});

describe('responseError structured protocol', () => {
  it('carries code/retryable/details/retryAfterMs as data, not just a sentence', async () => {
    const err = await structuredError(
      {
        code: 'session_limit',
        message: '同时录音已达上限（4/4 路占用中），正在等待空位',
        hint: '正在等待空位',
        retryable: true,
        details: { live: 4, limit: 4 },
      },
      429,
      { 'retry-after': '2' },
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('session_limit');
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ live: 4, limit: 4 });
    expect(err.retryAfterMs).toBe(2000);
  });

  it('does not stutter when the sentence already contains the hint', async () => {
    const err = await structuredError({
      code: 'session_limit',
      message: '同时录音已达上限（4/4 路占用中），正在等待空位',
      hint: '正在等待空位',
      retryable: true,
    });
    expect(err.message).toBe('同时录音已达上限（4/4 路占用中），正在等待空位');
  });

  it('tolerates a body whose detail fields are the wrong type', async () => {
    const err = await structuredError({ code: 7, details: [1, 2] }, 500);
    expect(err.code).toBeNull();
    expect(err.details).toEqual({});
    expect(err.retryable).toBeNull();
    // A missing Retry-After means "no hint", not "wait 0ms".
    expect(err.retryAfterMs).toBeNull();
  });

  it('leaves a non-JSON body without any protocol fields', async () => {
    const err = await responseError(fakeResponse('gateway blew up'));
    expect(err.code).toBeNull();
    expect(err.details).toEqual({});
  });
});
