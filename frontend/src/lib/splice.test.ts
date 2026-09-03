import { describe, expect, it } from 'vitest';
import { applySplice } from './splice';

describe('applySplice', () => {
  it('applies UTF-16 offsets around supplementary characters', () => {
    expect(applySplice('😀a', { start: 2, remove: 1, text: 'b' })).toBe('😀b');
    expect(applySplice('a😀b', { start: 1, remove: 2, text: '😃' })).toBe('a😃b');
    expect(applySplice('😀abc', { start: 3, remove: 0, text: 'X' })).toBe('😀aXbc');
    expect(applySplice('A😀B', { start: 1, remove: 2, text: '' })).toBe('AB');
    expect(applySplice('😀abc', { start: 5, remove: 0, text: '!' })).toBe('😀abc!');
  });

  it('preserves the existing BMP splice behavior', () => {
    expect(applySplice('今天天气不错', { start: 4, remove: 2, text: '很好' })).toBe('今天天气很好');
  });
});
