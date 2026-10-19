import { describe, expect, it } from 'vitest';
import { base64Bytes, extLabel, extOf, formatSize, rejectUploadFile } from './uploadPreflight';

describe('extOf', () => {
  it('lowercases the trailing extension', () => {
    expect(extOf('Lecture.MP4')).toBe('.mp4');
    expect(extOf('a.b.wav')).toBe('.wav');
  });
  it('returns empty for a nameless extension', () => {
    expect(extOf('noext')).toBe('');
  });
});

describe('formatSize', () => {
  it('picks a unit that keeps the number readable', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatSize(2 * 1024 ** 3)).toBe('2 GB');
  });
  it('does not invent a size for zero', () => {
    expect(formatSize(0)).toBe('0 B');
  });
});

describe('base64Bytes', () => {
  it('reports the decoded length including padding', () => {
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes(btoa('abc').toString())).toBe(3);
    expect(base64Bytes(btoa('ab').toString())).toBe(2);
    expect(base64Bytes(btoa('a').toString())).toBe(1);
  });
});

describe('rejectUploadFile', () => {
  const limits = { maxBytes: 2 * 1024 ** 3, allowedExts: ['.mp3', '.wav', '.pcm'] };

  it('accepts a file inside both limits', () => {
    expect(rejectUploadFile({ name: 'a.mp3', size: 1024 }, limits)).toBeNull();
  });

  it('names the rejected extension and the accepted list', () => {
    const msg = rejectUploadFile({ name: 'a.zip', size: 10 }, limits);
    expect(msg).toContain('.zip');
    expect(msg).toContain('mp3 / wav / pcm');
  });

  it('allows a nameless file, matching the backend check', () => {
    expect(rejectUploadFile({ name: 'raw', size: 10 }, limits)).toBeNull();
  });

  it('rejects an oversize file with both sizes in the message', () => {
    const msg = rejectUploadFile({ name: 'a.wav', size: 3 * 1024 ** 3 }, limits);
    expect(msg).toContain('3 GB');
    expect(msg).toContain('2 GB');
  });

  it('says nothing about size when the server limit is not known yet', () => {
    expect(rejectUploadFile({ name: 'a.wav', size: 9 * 1024 ** 3 }, { allowedExts: ['.wav'] })).toBeNull();
  });
});

describe('extLabel', () => {
  it('drops the leading dots', () => {
    expect(extLabel(['.mp3', 'wav'])).toBe('mp3 / wav');
  });
});
