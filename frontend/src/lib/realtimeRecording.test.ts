import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, parseRetryAfterMs } from './errors';
import {
  CAPACITY_RETRY_BASE_MS,
  CAPACITY_RETRY_MAX_MS,
  CAPACITY_TERMINAL_STATUSES,
  RECORDER_MIME_CANDIDATES,
  blobToBase64,
  capacityRetryDelayMs,
  capacityRetryNotice,
  createSessionWithCapacityRetry,
  formatFromMime,
  microphoneErrorMessage,
  parseCapacityRefusal,
  pickRecorderMimeType,
  transcriptFileName,
} from './realtimeRecording';

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.unstubAllGlobals();
});

type RecorderStub = { isTypeSupported?: (mime: string) => boolean } | null;

/** null means "this browser has no MediaRecorder at all". */
const stubMediaRecorder = (recorder: RecorderStub) => {
  const g = globalThis as Record<string, unknown>;
  const had = 'MediaRecorder' in g;
  const previous = g.MediaRecorder;
  if (recorder === null) delete g.MediaRecorder;
  else g.MediaRecorder = recorder;
  restore.push(() => {
    if (had) g.MediaRecorder = previous;
    else delete g.MediaRecorder;
  });
};

describe('transcriptFileName', () => {
  it('names the file by the moment it was downloaded', () => {
    const name = transcriptFileName('txt', new Date(2026, 9, 20, 15, 30));
    expect(name).toBe('realtime-2026-10-20-1530.txt');
  });
  it('zero-pads every field so the names sort chronologically', () => {
    expect(transcriptFileName('txt', new Date(2026, 0, 5, 9, 7))).toBe('realtime-2026-01-05-0907.txt');
  });
  it('carries the recording container into the extension', () => {
    expect(transcriptFileName('webm', new Date(2026, 9, 20, 15, 30))).toBe('realtime-2026-10-20-1530.webm');
  });
});

describe('pickRecorderMimeType', () => {
  it('prefers Opus-in-WebM, the container the server converts most reliably', () => {
    stubMediaRecorder({ isTypeSupported: () => true });
    expect(pickRecorderMimeType()).toBe('audio/webm;codecs=opus');
  });
  it('falls back down the candidate list, never past its end', () => {
    stubMediaRecorder({ isTypeSupported: (mime) => !mime.includes('opus') });
    expect(pickRecorderMimeType()).toBe('audio/webm');
    stubMediaRecorder({ isTypeSupported: (mime) => mime === 'audio/ogg' });
    expect(pickRecorderMimeType()).toBe('audio/ogg');
  });
  it('accepts an unlisted type when the browser reports nothing it supports', () => {
    stubMediaRecorder({ isTypeSupported: () => false });
    expect(pickRecorderMimeType()).toBe('');
  });
  it('still returns something when the browser exposes no isTypeSupported at all', () => {
    // `isTypeSupported` missing is treated as "any request is fine", so the
    // first candidate is handed back rather than nothing.
    stubMediaRecorder({});
    expect(pickRecorderMimeType()).toBe(RECORDER_MIME_CANDIDATES[0]);
  });
  it('returns nothing when MediaRecorder itself is missing', () => {
    stubMediaRecorder(null);
    expect(pickRecorderMimeType()).toBe('');
  });
});

describe('formatFromMime', () => {
  it('maps the chosen container to the extension the ffmpeg step is told', () => {
    expect(formatFromMime('audio/webm;codecs=opus')).toBe('webm');
    expect(formatFromMime('audio/ogg;codecs=opus')).toBe('ogg');
    expect(formatFromMime('audio/wav')).toBe('wav');
  });
  it('does not care about case', () => {
    expect(formatFromMime('Audio/OGG')).toBe('ogg');
  });
  it('defaults to webm rather than reporting an empty format', () => {
    expect(formatFromMime('')).toBe('webm');
  });
});

describe('microphoneErrorMessage', () => {
  it('turns a permission denial into the action that fixes it', () => {
    expect(microphoneErrorMessage({ name: 'NotAllowedError', message: 'Permission denied' }))
      .toContain('麦克风权限被拒绝');
    expect(microphoneErrorMessage({ name: 'SecurityError' })).toContain('锁形图标');
  });
  it('tells the user to look at their audio devices when nothing was found', () => {
    expect(microphoneErrorMessage({ name: 'NotFoundError' })).toContain('没有找到可用的麦克风');
    expect(microphoneErrorMessage({ name: 'OverconstrainedError' })).toContain('输入设备');
  });
  it('names the occupied-device case, which is the one users cannot self-diagnose', () => {
    expect(microphoneErrorMessage({ name: 'NotReadableError' })).toContain('被其他程序占用');
  });
  it('explains NotSupportedError instead of echoing "Not supported"', () => {
    const message = microphoneErrorMessage({ name: 'NotSupportedError', message: 'Not supported' });
    expect(message).not.toContain('Not supported');
    expect(message).toContain('音频输入设备');
  });
  it('falls back to the raw message for anything else, including a null', () => {
    expect(microphoneErrorMessage(new Error('boom'))).toBe('boom');
    expect(microphoneErrorMessage(null)).toBe('null');
  });
});

describe('blobToBase64', () => {
  it('encodes bytes in order, including the ones above 0x7f', async () => {
    const base64 = await blobToBase64(new Blob([new Uint8Array([0, 128, 255, 65])]));
    expect(Array.from(Buffer.from(base64, 'base64'))).toEqual([0, 128, 255, 65]);
  });
  it('handles an empty chunk without throwing', async () => {
    expect(await blobToBase64(new Blob([]))).toBe('');
  });
});

describe('CAPACITY_TERMINAL_STATUSES', () => {
  it('counts only live sessions against the cap', () => {
    const sessions = [
      { status: 'recording' },
      { status: 'processing' },
      { status: 'done' },
      { status: 'failed' },
      { status: 'closed' },
      { status: undefined },
    ];
    const live = sessions.filter((s) => !CAPACITY_TERMINAL_STATUSES.includes(s.status || ''));
    expect(live.map((s) => s.status)).toEqual(['recording', 'processing', undefined]);
  });
});

// ---- the capacity refusal, as something the panel can act on ---------------

const capacityError = (
  status: number,
  body: Record<string, unknown>,
  retryAfter: string | null = '2',
): ApiError =>
  new ApiError('同时录音已达上限（4/4 路占用中），正在等待空位', {
    status,
    retryable: true,
    ...body,
    retryAfterMs: parseRetryAfterMs(retryAfter),
  });

/** A fetch response shaped like the gateway's: FastAPI's detail object plus the header. */
const responseOf = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response);

describe('parseCapacityRefusal', () => {
  it('reads the counters and the server hint out of the error object', () => {
    const refusal = parseCapacityRefusal(
      capacityError(429, {
        code: 'session_limit',
        hint: '正在等待空位',
        details: { live: 4, limit: 4 },
      }),
    );
    expect(refusal).toEqual({ live: 4, limit: 4, retryAfterMs: 2000 });
  });

  it('recognises the refusal by status when the code is missing', () => {
    // A proxy that strips the detail object still leaves 429 + Retry-After,
    // which is enough to decide "wait" even without the counters.
    const refusal = parseCapacityRefusal(capacityError(429, {}, null));
    expect(refusal).toEqual({ live: null, limit: null, retryAfterMs: null });
  });

  it('is not a capacity refusal', () => {
    expect(parseCapacityRefusal(new Error('boom'))).toBeNull();
    // retryable:false is the server saying "asking again will not help" —
    // a resource cap, not a full pool.
    expect(
      parseCapacityRefusal(
        new ApiError('本次录音已达到资源上限，请重新开始', {
          status: 413,
          code: 'resource_limit',
          retryable: false,
        }),
      ),
    ).toBeNull();
    expect(parseCapacityRefusal(capacityError(500, { code: 'internal_error' }))).toBeNull();
  });

  it('tolerates counters that are not numbers', () => {
    const refusal = parseCapacityRefusal(
      capacityError(429, { code: 'session_limit', details: { live: '4', limit: null } }),
    );
    expect(refusal?.live).toBeNull();
    expect(refusal?.limit).toBeNull();
  });
});

describe('capacityRetryDelayMs', () => {
  it('starts at the server hint and backs off from it', () => {
    const refusal = { live: 4, limit: 4, retryAfterMs: 2000 };
    expect(capacityRetryDelayMs(refusal, 0)).toBe(2000);
    expect(capacityRetryDelayMs(refusal, 1)).toBe(4000);
    expect(capacityRetryDelayMs(refusal, 2)).toBe(8000);
  });

  it('honours a longer hint but never exceeds the ceiling', () => {
    const refusal = { live: 1, limit: 1, retryAfterMs: 10000 };
    expect(capacityRetryDelayMs(refusal, 0)).toBe(10000);
    expect(capacityRetryDelayMs(refusal, 1)).toBe(CAPACITY_RETRY_MAX_MS);
    expect(capacityRetryDelayMs(refusal, 9)).toBe(CAPACITY_RETRY_MAX_MS);
  });

  it('floors at 2s when the server sent no hint, so the pool is not hammered', () => {
    const refusal = { live: null, limit: null, retryAfterMs: null };
    expect(capacityRetryDelayMs(refusal, 0)).toBe(CAPACITY_RETRY_BASE_MS);
    expect(capacityRetryDelayMs(refusal, -1)).toBe(CAPACITY_RETRY_BASE_MS);
  });
});

describe('capacityRetryNotice', () => {
  it('turns the badge numbers into the reason the button is idle', () => {
    expect(
      capacityRetryNotice({ live: 4, limit: 4, retryAfterMs: 2000 }, 0),
    ).toBe('当前 4/4 路占用中，正在等待空位（第 1/6 次）');
  });

  it('says what to do instead of waiting when the attempts run out', () => {
    const notice = capacityRetryNotice({ live: 1, limit: 1, retryAfterMs: null }, 5, 6);
    expect(notice).toContain('当前 1/1 路占用中');
    expect(notice).toContain('REALTIME_MAX_SESSIONS');
  });

  it('still explains itself when the counters are missing', () => {
    expect(capacityRetryNotice({ live: null, limit: null, retryAfterMs: null }, 0)).toContain(
      '录音并发名额已满',
    );
  });
});

describe('createSessionWithCapacityRetry', () => {
  const full = () =>
    responseOf(
      429,
      {
        detail: {
          code: 'session_limit',
          message: '同时录音已达上限（2/2 路占用中），正在等待空位',
          hint: '正在等待空位',
          retryable: true,
          details: { live: 2, limit: 2 },
        },
      },
      { 'retry-after': '2' },
    );

  it('waits and asks again until a slot frees up', async () => {
    const delays: number[] = [];
    const notices: string[] = [];
    let calls = 0;
    const response = await createSessionWithCapacityRetry(
      async () => {
        calls += 1;
        return calls < 3 ? full() : responseOf(200, { session_id: 's' });
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        onRefused: (refusal, attempt, delayMs) => {
          notices.push(capacityRetryNotice(refusal, attempt) + `@${delayMs}`);
        },
      },
    );
    expect(calls).toBe(3);
    expect(response.ok).toBe(true);
    expect(delays).toEqual([2000, 4000]);
    expect(notices[0]).toBe('当前 2/2 路占用中，正在等待空位（第 1/6 次）@2000');
  });

  it('gives up after a bounded number of waits and returns the refusal', async () => {
    const delays: number[] = [];
    let calls = 0;
    const response = await createSessionWithCapacityRetry(
      async () => {
        calls += 1;
        return full();
      },
      { maxAttempts: 3, sleep: async (ms) => void delays.push(ms) },
    );
    expect(calls).toBe(4); // the first try plus three retries
    expect(response.status).toBe(429);
    // Bounded by maxAttempts, and each wait is the backoff ladder.
    expect(delays).toEqual([2000, 4000, 8000]);
  });

  it('stops waiting when the panel has moved on', async () => {
    let calls = 0;
    let generation = 1;
    const response = await createSessionWithCapacityRetry(
      async () => {
        calls += 1;
        return full();
      },
      {
        shouldAbort: () => generation !== 1,
        sleep: async () => {
          generation += 1; // the user stopped the recording during the wait
        },
      },
    );
    expect(calls).toBe(1);
    expect(response.status).toBe(429);
  });

  it('returns any other failure untouched, on the first response', async () => {
    const delays: number[] = [];
    const response = await createSessionWithCapacityRetry(
      async () => responseOf(422, { detail: { code: 'provider_rejected', message: '上游拒绝了音频' } }),
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(response.status).toBe(422);
    expect(delays).toEqual([]);
  });

  it('passes a plain ok response straight through', async () => {
    const response = await createSessionWithCapacityRetry(async () => responseOf(200, {}));
    expect(response.ok).toBe(true);
  });
});
