import { describe, it, expect } from 'vitest';
import { formatDur } from './download';

describe('formatDur', () => {
  it('uses hours + minutes above an hour', () => {
    expect(formatDur(3661)).toBe('1h1m');
  });
  it('uses minutes + seconds below an hour', () => {
    expect(formatDur(65)).toBe('1m5s');
  });
  it('handles zero', () => {
    expect(formatDur(0)).toBe('0m0s');
  });
});
