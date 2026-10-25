// Extract a human-readable message from an unknown thrown value.
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * A failed HTTP call, with the parts of the backend's error protocol that a
 * caller needs as data rather than as a sentence.
 *
 * `message` is what to show. `code`, `retryable`, `details` and `retryAfterMs`
 * are what to act on: the capacity refusal is only worth retrying (and only
 * worth waiting for) because it says which cap was hit, how full it is, and how
 * soon the server is willing to be asked again.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly hint: string | null;
  readonly retryable: boolean | null;
  readonly details: Record<string, unknown>;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    init: {
      status: number;
      code?: unknown;
      hint?: unknown;
      retryable?: unknown;
      details?: unknown;
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = typeof init.code === 'string' ? init.code : null;
    this.hint = typeof init.hint === 'string' ? init.hint : null;
    this.retryable = typeof init.retryable === 'boolean' ? init.retryable : null;
    this.details =
      init.details && typeof init.details === 'object' && !Array.isArray(init.details)
        ? (init.details as Record<string, unknown>)
        : {};
    this.retryAfterMs = init.retryAfterMs ?? null;
  }
}

/** `Retry-After` as milliseconds. The gateway only ever sends delta-seconds;
 *  the HTTP-date form is not worth a Date.parse here, so an unparseable value
 *  is reported as "no hint" and the caller falls back to its own backoff. */
export const parseRetryAfterMs = (value: string | null): number | null => {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
};

/**
 * Turn a failed fetch response into the message we actually want to show.
 *
 * FastAPI errors arrive as {"detail": "..."} — surfacing that JSON verbatim
 * buries the sentence the backend wrote for the user (e.g. 同时录音已达上限).
 * Prefer detail, then fall back to the raw text, then to the status code.
 */
export const responseError = async (r: Response): Promise<ApiError> => {
  const raw = await r.text().catch(() => '');
  let detail = '';
  let body: unknown = null;
  try {
    const parsed = JSON.parse(raw);
    body = parsed?.detail;
    if (typeof body === 'string') {
      detail = body;
    } else if (body && typeof body === 'object') {
      const fields = body as Record<string, unknown>;
      const message = typeof fields.message === 'string' ? fields.message : '';
      const hint = typeof fields.hint === 'string' ? fields.hint : '';
      // Some backend errors already spell the hint inside the sentence (the
      // realtime capacity error does), so appending it again reads as a stutter.
      detail = message && hint && !message.includes(hint) ? `${message}（${hint}）` : message;
    }
  } catch {
    /* not JSON; use the raw body below */
  }
  const structured: Record<string, unknown> =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return new ApiError(detail || raw || `HTTP ${r.status}`, {
    status: r.status,
    ...structured,
    retryAfterMs: parseRetryAfterMs(r.headers?.get?.('Retry-After') ?? null),
  });
};
