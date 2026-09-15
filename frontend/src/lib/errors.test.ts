import { describe, it, expect } from 'vitest';
import { errorMessage, responseError } from './errors';

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

  it('ignores a JSON body whose detail is not a string', async () => {
    const err = await responseError(fakeResponse('{"detail":{"code":7}}', 500));
    expect(err.message).toBe('{"detail":{"code":7}}');
  });
});
