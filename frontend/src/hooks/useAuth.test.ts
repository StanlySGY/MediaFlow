import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAuth } from './useAuth';

describe('useAuth', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

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

  it('clears the browser SSE cookie when the user logs out', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth());

    act(() => result.current.setToken('xyz'));
    act(() => result.current.clearSession());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    }));
    expect(result.current.token).toBe('');
  });

  it('shares one token prompt across concurrent 401 responses', async () => {
    const unauthorized = { status: 401 } as Response;
    const ok = { status: 200, ok: true } as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValue(ok);
    const promptMock = vi.fn(() => 'fresh-token');
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', promptMock);
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await Promise.all([
        result.current.authedFetch('/first'),
        result.current.authedFetch('/second'),
      ]);
    });

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(localStorage.getItem('asr_token')).toBe('fresh-token');
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe('Bearer fresh-token');
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get('Authorization')).toBe('Bearer fresh-token');
  });

  it('does not prompt again for a later in-flight 401 after cancellation', async () => {
    let resolveSecond!: (response: Response) => void;
    const secondResponse = new Promise<Response>(resolve => { resolveSecond = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 401 } as Response)
      .mockReturnValueOnce(secondResponse)
      .mockResolvedValue({ status: 204, ok: true } as Response);
    const promptMock = vi.fn(() => null);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', promptMock);
    const { result } = renderHook(() => useAuth());
    let firstRequest!: Promise<Response>;
    let secondRequest!: Promise<Response>;

    act(() => {
      firstRequest = result.current.authedFetch('/first');
      secondRequest = result.current.authedFetch('/second');
    });
    await act(async () => { await firstRequest; });
    resolveSecond({ status: 401 } as Response);
    await act(async () => { await secondRequest; });

    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/auth/logout');
  });

  it('clears the browser SSE cookie when a 401 prompt is cancelled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', vi.fn(() => null));
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.authedFetch('/protected');
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(['/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    }]);
    expect(result.current.token).toBe('');
  });

  it('retries a stale 401 with the token changed after the request began', async () => {
    localStorage.setItem('asr_token', 'old-token');
    let resolveInitial!: (response: Response) => void;
    const initialResponse = new Promise<Response>(resolve => { resolveInitial = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(initialResponse)
      .mockResolvedValueOnce({ status: 200, ok: true } as Response);
    const promptMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', promptMock);
    const { result } = renderHook(() => useAuth());
    let request!: Promise<Response>;

    act(() => { request = result.current.authedFetch('/protected'); });
    act(() => result.current.setToken('new-token'));
    await act(async () => {
      resolveInitial({ status: 401 } as Response);
      await request;
    });

    expect(localStorage.getItem('asr_token')).toBe('new-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer new-token');
    expect(promptMock).not.toHaveBeenCalled();
  });

  it('keeps a newer token when it changes while the 401 prompt is pending', async () => {
    localStorage.setItem('asr_token', 'old-token');
    let resolvePrompt!: (value: string | null) => void;
    const pendingPrompt = new Promise<string | null>(resolve => { resolvePrompt = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 401 } as Response)
      .mockResolvedValueOnce({ status: 200, ok: true } as Response);
    const promptMock = vi.fn(() => pendingPrompt);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', promptMock);
    const { result } = renderHook(() => useAuth());
    let request!: Promise<Response>;

    act(() => { request = result.current.authedFetch('/protected'); });
    await waitFor(() => expect(promptMock).toHaveBeenCalledTimes(1));
    act(() => result.current.setToken('new-token'));
    await act(async () => {
      resolvePrompt('prompt-token');
      await request;
    });

    expect(localStorage.getItem('asr_token')).toBe('new-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer new-token');
  });

  it('sseUrl keeps the access token out of the EventSource URL', () => {
    const { result } = renderHook(() => useAuth());
    const origin = window.location.origin;
    expect(result.current.sseUrl('/x')).toBe(`${origin}/x`);
    act(() => result.current.setToken('t k'));
    expect(result.current.sseUrl('/x')).toBe(`${origin}/x`);
  });
});
