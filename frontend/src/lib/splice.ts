import { ASRDelta } from '../types';

/** Apply a structured splice edit op to the previously-committed transcript
 * text. Mirrors the backend's reconstruction rule:
 *
 *     new = previous[:start] + text + previous[start + remove:]
 *
 * `slice` uses UTF-16 code units, which matches the backend's Unicode code
 * point offsets for BMP characters (ASCII and CJK). */
export const applySplice = (previous: string, delta: ASRDelta): string => {
  const start = Number.isFinite(delta.start) ? delta.start : 0;
  const remove = Number.isFinite(delta.remove) ? delta.remove : 0;
  const text = typeof delta.text === 'string' ? delta.text : '';
  return previous.slice(0, start) + text + previous.slice(start + remove);
};