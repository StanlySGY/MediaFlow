import type { ASRSegment } from '../types';

// Mirror the backend's segment-level subtitle output (app/services/subtitles.py) so locally
// proofread segment text can be exported to SRT/VTT without a server round-trip.
export const fmtSubtitleTime = (sec: number, comma: boolean): string => {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  let s = Math.floor(sec % 60);
  let ms = Math.round((sec - Math.floor(sec)) * 1000);
  if (ms === 1000) { ms = 0; s += 1; }
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${comma ? ',' : '.'}${p(ms, 3)}`;
};

/** One subtitle cue. `start`/`end` are seconds from the start of the recording;
 *  who measured them is the caller's business (file segments carry the media
 *  timeline, a realtime session carries its own clock). */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** Drop empty cues and keep every cue at least 0.1s long, as the backend does:
 *  a zero-length cue is unreadable in every player. */
const usableCues = (cues: SubtitleCue[]): SubtitleCue[] =>
  cues
    .filter((c) => c.text && c.text.trim())
    .map((c) => ({ start: Math.max(0, c.start), end: c.end <= c.start ? c.start + 0.1 : c.end, text: c.text.trim() }));

const cuesFromSegments = (segs: ASRSegment[]): SubtitleCue[] =>
  [...segs]
    .sort((a, b) => a.segment_id - b.segment_id)
    .filter((s) => s.text && s.text.trim() && !s.error)
    .map((s) => ({ start: s.start, end: s.end, text: s.text }));

export const buildSrtFromCues = (cues: SubtitleCue[]): string =>
  usableCues(cues)
    .map((e, i) => `${i + 1}\n${fmtSubtitleTime(e.start, true)} --> ${fmtSubtitleTime(e.end, true)}\n${e.text}\n`)
    .join('\n');

export const buildVttFromCues = (cues: SubtitleCue[]): string => {
  const body = ['WEBVTT', ''];
  usableCues(cues).forEach((e, i) => {
    body.push(String(i + 1), `${fmtSubtitleTime(e.start, false)} --> ${fmtSubtitleTime(e.end, false)}`, e.text, '');
  });
  return body.join('\n');
};

export const buildSrt = (segs: ASRSegment[]): string => buildSrtFromCues(cuesFromSegments(segs));

export const buildVtt = (segs: ASRSegment[]): string => buildVttFromCues(cuesFromSegments(segs));

/**
 * Join proofread segments into the full-text pane's content.
 *
 * Mirrors what the backend does with a plain `_dedupe_join` (no word timestamps
 * once the text has been edited): concatenate in segment order, inserting a
 * space only between two non-CJK boundaries so Chinese does not gain gaps.
 * Segments that failed or produced nothing are skipped, as in buildSrt.
 */
export const mergeSegments = (segs: ASRSegment[]): string => {
  const parts = [...segs]
    .sort((a, b) => a.segment_id - b.segment_id)
    .filter((s) => s.text && s.text.trim() && !s.error)
    .map((s) => s.text.trim());
  let out = '';
  for (const part of parts) {
    if (!out) {
      out = part;
      continue;
    }
    // The backend's rule looks only at the *left* boundary: it inserts a space
    // when the previous character is not CJK, so "校对后的" + "transcript"
    // stays glued exactly as the server would render it.
    out += isCjkBoundary(out[out.length - 1]) ? part : ` ${part}`;
  }
  return out;
};

const isCjkBoundary = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (0x3000 <= cp && cp <= 0x303f) ||
    (0x3040 <= cp && cp <= 0x30ff) ||
    (0x3400 <= cp && cp <= 0x4dbf) ||
    (0x4e00 <= cp && cp <= 0x9fff) ||
    (0xf900 <= cp && cp <= 0xfaff) ||
    (0xff00 <= cp && cp <= 0xffef) ||
    (0x20000 <= cp && cp <= 0x2a6df)
  );
};
