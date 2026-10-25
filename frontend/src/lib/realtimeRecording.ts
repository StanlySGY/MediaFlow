import { ApiError, errorMessage, responseError } from './errors';

/**
 * The non-React half of the realtime recorder.
 *
 * These are the decisions a recording is made of — which container the browser
 * is asked to write, what the downloaded file is called, what a failed
 * microphone permission means in Chinese, how a blob becomes the base64 the
 * WebSocket frame wants. None of them need a component, and every one of them
 * is the kind of thing that silently regresses when a browser changes what it
 * reports, so they live here where they can be tested without mounting a panel.
 */

/** RealtimeManager.list() returns every session it still holds, including the
 *  terminal ones; only non-terminal ones occupy a slot in the cap. */
export const CAPACITY_TERMINAL_STATUSES: string[] = ['done', 'failed', 'closed'];

/**
 * The capacity refusal, read as data.
 *
 * The server answers a full cap with 429 / code="session_limit" and
 * details={live, limit}, plus a Retry-After. That is the difference between
 * "you are the fifth recorder" (wait, someone will finish) and "the cap is one"
 * (this deployment needs `REALTIME_MAX_SESSIONS` raised, and waiting forever is
 * just a longer way of failing). Both readings need the numbers, so the panel
 * reads them out of the error object instead of pattern-matching the sentence.
 */
export type CapacityRefusal = {
  live: number | null;
  limit: number | null;
  /** The server's own Retry-After, in ms, when it sent one. */
  retryAfterMs: number | null;
};

/** 429 is the only status the gateway uses for a full cap; `retryable` is the
 *  server's own word for "ask again". Both are checked so a code rename cannot
 *  silently turn a wait into a dead end. */
export const parseCapacityRefusal = (error: unknown): CapacityRefusal | null => {
  if (!(error instanceof ApiError)) return null;
  if (error.code !== 'session_limit' && error.status !== 429) return null;
  if (error.retryable === false) return null;
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    live: num(error.details?.live),
    limit: num(error.details?.limit),
    retryAfterMs: error.retryAfterMs,
  };
};

/** Retry floor and ceiling. The floor is the server's 2s Retry-After: a
 *  recording frees its slot within one chunk cycle, so polling faster than that
 *  only adds load to the manager that just refused. The ceiling exists because a
 *  cap can be saturated by hour-long recordings, and a client that retries
 *  every 15s for a few minutes is still a user who can act, not a spinner. */
export const CAPACITY_RETRY_BASE_MS = 2000;
export const CAPACITY_RETRY_MAX_MS = 15000;
export const CAPACITY_RETRY_MAX_ATTEMPTS = 6;

/** attempt is 0-based: the first wait honours the server's hint, later ones
 *  back off from it so a genuinely busy pool is not hammered. */
export const capacityRetryDelayMs = (
  refusal: CapacityRefusal,
  attempt: number,
): number => {
  const base = Math.max(CAPACITY_RETRY_BASE_MS, refusal.retryAfterMs ?? CAPACITY_RETRY_BASE_MS);
  return Math.min(base * 2 ** Math.max(0, attempt), CAPACITY_RETRY_MAX_MS);
};

/** What the user sees while the panel waits: the same "在用 4/4 路" numbers the
 *  badge already shows, turned from a static counter into the reason the
 *  开始录音 button has not done anything yet. */
export const capacityRetryNotice = (
  refusal: CapacityRefusal,
  attempt: number,
  maxAttempts = CAPACITY_RETRY_MAX_ATTEMPTS,
): string => {
  const full =
    refusal.live !== null && refusal.limit !== null
      ? `当前 ${refusal.live}/${refusal.limit} 路占用中`
      : '录音并发名额已满';
  return attempt >= maxAttempts - 1
    ? `${full}，等待 ${maxAttempts} 次仍没有空位。请结束一路录音，或让管理员调大 REALTIME_MAX_SESSIONS。`
    : `${full}，正在等待空位（第 ${attempt + 1}/${maxAttempts} 次）`;
};

/**
 * POST a session-creation request, retrying only a capacity refusal.
 *
 * Returns the final Response rather than throwing, so the caller's existing
 * "not ok -> show the sentence" path still handles every other failure
 * exactly as it did. `shouldAbort` is checked before each wait: the panel
 * bumps its generation when the user stops or unmounts, and a waiting retry
 * must not resurrect a recording nobody asked for.
 */
export const createSessionWithCapacityRetry = async (
  request: () => Promise<Response>,
  {
    shouldAbort = () => false,
    onRefused,
    maxAttempts = CAPACITY_RETRY_MAX_ATTEMPTS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    shouldAbort?: () => boolean;
    onRefused?: (refusal: CapacityRefusal, attempt: number, delayMs: number) => void;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Response> => {
  let response = await request();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (response.ok || shouldAbort()) return response;
    const refusal = parseCapacityRefusal(await responseError(response));
    if (!refusal || shouldAbort()) return response;
    const delayMs = capacityRetryDelayMs(refusal, attempt);
    onRefused?.(refusal, attempt, delayMs);
    await sleep(delayMs);
    // Checked again after the wait: if the user stopped or unmounted while we
    // slept, posting anyway would resurrect a recording nobody asked for.
    if (shouldAbort()) return response;
    response = await request();
  }
  return response;
};


/** Preferred order: Opus-in-WebM is what the server's ffmpeg step handles best,
 *  so it is asked for first and the rest are fallbacks for browsers without it. */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** Empty string means "let the browser pick", which is still a usable recording
 *  — it is only `MediaRecorder` itself being absent that leaves nothing to do. */
export const pickRecorderMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
};

export const formatFromMime = (mimeType: string) => {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  return 'webm';
};

/** "realtime-2026-10-20-1530.txt" — a constant filename meant every recording
 *  downloaded over the last one, and the browser's "keep both" fallback leaves
 *  files nobody can tell apart. */
export const transcriptFileName = (ext = 'txt', now = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}`;
  return `realtime-${day}-${time}.${ext}`;
};

/**
 * getUserMedia rejections are the most likely failure a first-time user hits,
 * and the DOMException messages are short English strings ("Permission denied")
 * that do not say what to do. Each branch below names the one action that fixes
 * it on the machine the console is actually running on.
 */
export const microphoneErrorMessage = (error: unknown): string => {
  const name = (error as { name?: string })?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '麦克风权限被拒绝。请点地址栏左侧的锁形图标，把「麦克风」改成允许，然后重新开始录音。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没有找到可用的麦克风。请插好麦克风，或在系统声音设置里确认输入设备已启用。';
    case 'NotReadableError':
      return '麦克风被其他程序占用（会议软件、录音工具），或系统未授予浏览器麦克风权限。关掉占用它的程序后再试。';
    case 'AbortError':
      return '麦克风初始化被中断，请重新开始录音。';
    case 'NotSupportedError':
      // Chrome's own wording is the two-word string "Not supported", which says
      // nothing about what is missing. This one fires when the page cannot reach
      // an audio device at all: no capture device in the OS, a remote desktop /
      // VM session with no sound hardware, or a browser build without recording.
      return '当前环境无法开启录音：系统里没有可用的音频输入设备，或这个浏览器不支持录音。请在系统声音设置里确认输入设备，远程桌面/无麦克风的环境无法使用实时录音。';
    default:
      return errorMessage(error);
  }
};

export const blobToBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};
