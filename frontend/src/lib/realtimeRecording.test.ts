import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_TERMINAL_STATUSES,
  RECORDER_MIME_CANDIDATES,
  blobToBase64,
  formatFromMime,
  microphoneErrorMessage,
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
