import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuth } from './useAuth';

describe('useAuth', () => {
  beforeEach(() => localStorage.clear());

  it('reads the initial token from localStorage', () => {
    localStorage.setItem('asr_token', 'abc');
    const { result } = renderHook(() => useAuth());
    expect(result.current.token).toBe('abc');
  });

  it('setToken persists a value and clears on empty', () => {
    const { result } = renderHook(() => useAuth());
    act(() => result.current.setToken('xyz'));
    expect(localStorage.getItem('asr_token')).toBe('xyz');
    expect(result.current.token).toBe('xyz');
    act(() => result.current.setToken(''));
    expect(localStorage.getItem('asr_token')).toBeNull();
    expect(result.current.token).toBe('');
  });

  it('sseUrl appends an encoded token only when set', () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.sseUrl('/x')).toBe('/x');
    act(() => result.current.setToken('t k'));
    expect(result.current.sseUrl('/x')).toBe('/x?token=t%20k');
  });
});
