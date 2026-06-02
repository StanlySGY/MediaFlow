import { describe, it, expect } from 'vitest';
import { fmtSubtitleTime, buildSrt, buildVtt } from './subtitle';
import type { ASRSegment } from '../types';

const seg = (over: Partial<ASRSegment>): ASRSegment => ({
  segment_id: 1, start: 0, end: 1, text: 't', is_final: true, error: null, ...over,
});

describe('fmtSubtitleTime', () => {
  it('formats with comma for SRT', () => {
    expect(fmtSubtitleTime(3661.5, true)).toBe('01:01:01,500');
  });
  it('formats with dot for VTT', () => {
    expect(fmtSubtitleTime(3661.5, false)).toBe('01:01:01.500');
  });
  it('clamps negatives to zero', () => {
    expect(fmtSubtitleTime(-5, true)).toBe('00:00:00,000');
  });
  it('carries millisecond rounding up to the next second', () => {
    expect(fmtSubtitleTime(0.9999, true)).toBe('00:00:01,000');
  });
});

describe('buildSrt', () => {
  it('numbers entries, sorts by id, skips empty and errored segments', () => {
    const srt = buildSrt([
      seg({ segment_id: 2, start: 1, end: 2, text: 'world' }),
      seg({ segment_id: 1, start: 0, end: 1, text: 'hello' }),
      seg({ segment_id: 3, start: 2, end: 3, text: '   ' }),            // empty → skipped
      seg({ segment_id: 4, start: 3, end: 4, text: 'nope', error: 'e' }), // errored → skipped
    ]);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\nhello');
    expect(srt).toContain('2\n00:00:01,000 --> 00:00:02,000\nworld');
    expect(srt.match(/-->/g)?.length).toBe(2);
    expect(srt).not.toContain('nope');
  });
  it('pads zero-length segments so end > start', () => {
    const srt = buildSrt([seg({ start: 5, end: 5, text: 'tick' })]);
    expect(srt).toContain('00:00:05,000 --> 00:00:05,100');
  });
});

describe('buildVtt', () => {
  it('starts with the WEBVTT header and uses dot timestamps', () => {
    const vtt = buildVtt([seg({ start: 0, end: 1, text: 'hi' })]);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000');
    expect(vtt).toContain('hi');
  });
});
