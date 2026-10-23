import { describe, expect, it } from 'vitest';
import { createRealtimeCueTracker } from './realtimeCueTracker';

describe('createRealtimeCueTracker', () => {
  it('yields one cue for the whole session when no boundary ever closed', () => {
    // realtime_offline decodes everything at the end. Cutting it into invented
    // sentences would be a fabricated timeline; one measured cue is the truth.
    const tracker = createRealtimeCueTracker();
    expect(tracker.boundaryCount()).toBe(0);

    const cues = tracker.cues('一整段在停止录音后才出现的文字', 8_000);

    expect(cues).toEqual([{ start: 0, end: 8, text: '一整段在停止录音后才出现的文字' }]);
  });

  it('cuts at each measured boundary and times every cue from the session clock', () => {
    const tracker = createRealtimeCueTracker();
    const text = '第一句话在这里呀第二句话在这里呀'; // 8 + 8 chars

    tracker.closeBoundary(8, 4_200);
    tracker.closeBoundary(16, 9_800);
    expect(tracker.boundaryCount()).toBe(2);

    expect(tracker.cues(text, 12_000)).toEqual([
      { start: 0, end: 4.2, text: '第一句话在这里呀' },
      { start: 4.2, end: 9.8, text: '第二句话在这里呀' },
    ]);
  });

  it('keeps the tail cue running to the moment the session ended', () => {
    const tracker = createRealtimeCueTracker();
    tracker.closeBoundary(3, 1_000);
    expect(tracker.cues('前三字后三字', 5_500)).toEqual([
      { start: 0, end: 1, text: '前三字' },
      { start: 1, end: 5.5, text: '后三字' },
    ]);
  });

  it('stretches the previous cue when upstream restates text it already sent', () => {
    // realtime_ws restates the cumulative text, so a "final" can close a
    // boundary with nothing new in it. That instant is still when the sentence
    // ended, so the cue stays up until it.
    const tracker = createRealtimeCueTracker();
    tracker.closeBoundary(6, 2_000);
    tracker.closeBoundary(6, 3_000);

    expect(tracker.boundaryCount()).toBe(2);
    expect(tracker.cues('六六六六六六', 4_000)).toEqual([
      { start: 0, end: 3, text: '六六六六六六' },
    ]);
  });

  it('does not lose text or time when a restated boundary sits between two real ones', () => {
    const tracker = createRealtimeCueTracker();
    tracker.closeBoundary(6, 2_000);
    tracker.closeBoundary(6, 3_000); // restatement: no new characters
    tracker.closeBoundary(9, 5_000);

    expect(tracker.cues('六六六六六六九九九', 6_000)).toEqual([
      { start: 0, end: 3, text: '六六六六六六' },
      { start: 3, end: 5, text: '九九九' },
    ]);
  });

  it('clamps to the transcript as it stands when the server rewrites the tail', () => {
    // A splice can remove characters after a boundary closed, so the recorded
    // offsets can point past the end of the text.
    const tracker = createRealtimeCueTracker();
    tracker.closeBoundary(10, 2_000);

    expect(tracker.cues('短', 3_000)).toEqual([{ start: 0, end: 2, text: '短' }]);
  });

  it('never lets a cue end before it starts', () => {
    // Out-of-order elapsed_ms from an upstream that restarts its own clock.
    const tracker = createRealtimeCueTracker();
    tracker.closeBoundary(2, 5_000);
    tracker.closeBoundary(4, 1_000);

    const cues = tracker.cues('四个字符', 4_000);
    expect(cues.every((c) => c.end >= c.start)).toBe(true);
    expect(cues).toEqual([
      { start: 0, end: 5, text: '四个' },
      { start: 5, end: 5, text: '字符' },
    ]);
  });

  it('clears boundaries on reset so a new recording does not inherit the old clock', () => {
    const tracker = createRealtimeCueTracker();
    tracker.closeBoundary(2, 1_000);
    tracker.reset();

    expect(tracker.boundaryCount()).toBe(0);
    expect(tracker.cues('新的录音', 2_000)).toEqual([{ start: 0, end: 2, text: '新的录音' }]);
  });

  it('trims cue text and drops whitespace-only cues instead of exporting blank lines', () => {
    const tracker = createRealtimeCueTracker();
    tracker.closeBoundary(3, 1_000);
    tracker.closeBoundary(4, 2_000); // only a space landed in this sentence

    expect(tracker.cues('前  ', 3_000)).toEqual([{ start: 0, end: 2, text: '前' }]);
  });
});
