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

const subtitleEntries = (segs: ASRSegment[]) =>
  [...segs]
    .sort((a, b) => a.segment_id - b.segment_id)
    .filter((s) => s.text && s.text.trim() && !s.error)
    .map((s) => ({ start: s.start, end: s.end <= s.start ? s.start + 0.1 : s.end, text: s.text.trim() }));

export const buildSrt = (segs: ASRSegment[]): string =>
  subtitleEntries(segs)
    .map((e, i) => `${i + 1}\n${fmtSubtitleTime(e.start, true)} --> ${fmtSubtitleTime(e.end, true)}\n${e.text}\n`)
    .join('\n');

export const buildVtt = (segs: ASRSegment[]): string => {
  const body = ['WEBVTT', ''];
  subtitleEntries(segs).forEach((e, i) => {
    body.push(String(i + 1), `${fmtSubtitleTime(e.start, false)} --> ${fmtSubtitleTime(e.end, false)}`, e.text, '');
  });
  return body.join('\n');
};
