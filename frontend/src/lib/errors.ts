// Extract a human-readable message from an unknown thrown value.
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Turn a failed fetch response into the message we actually want to show.
 *
 * FastAPI errors arrive as {"detail": "..."} — surfacing that JSON verbatim
 * buries the sentence the backend wrote for the user (e.g. 同时录音已达上限).
 * Prefer detail, then fall back to the raw text, then to the status code.
 */
export const responseError = async (r: Response): Promise<Error> => {
  const raw = await r.text().catch(() => '');
  let detail = '';
  try {
    const parsed = JSON.parse(raw);
    const body = parsed?.detail;
    if (typeof body === 'string') {
      detail = body;
    } else if (body && typeof body === 'object') {
      const message = typeof body.message === 'string' ? body.message : '';
      const hint = typeof body.hint === 'string' ? body.hint : '';
      detail = message && hint ? `${message}（${hint}）` : message;
    }
  } catch {
    /* not JSON; use the raw body below */
  }
  return new Error(detail || raw || `HTTP ${r.status}`);
};
