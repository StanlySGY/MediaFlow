import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe('per-view document title', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/auth/info')) return json({ auth_required: false });
      if (u.includes('/asr/config')) return json({ provider: 'openai_compat', api_key_set: true });
      if (u.includes('/asr/health')) return json({ ok: true, configured: true });
      // 调用监控 reads summary/calls off the snapshot with no guard, so a bare
      // {} here crashes the view instead of proving the title.
      if (u.includes('/asr/monitor')) return json({ summary: { total: 0, running: 0, succeeded: 0, failed: 0, avg_elapsed_ms: 0, window_size: 200 }, calls: [] });
      return json({});
    }));
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  // The whole point of a hash link is that it opens the view it points at —
  // and the tab has to say which view that was.
  it('is set on the first load of a deep link', async () => {
    window.history.replaceState(null, '', '/#/history');
    render(<App />);
    expect(await screen.findByRole('heading', { name: /历史转写记录/ })).toBeInTheDocument();
    expect(document.title).toBe('历史记录 · MediaFlow');
  });

  // The effect is keyed on the view, so every deep link has to land on its own
  // title — 接口调试 and 音视频合并 are the two spellings most likely to fall
  // through a table lookup.
  it.each([
    ['#/concat', '音视频合并 · MediaFlow'],
    ['#/api-debug', '接口调试 · MediaFlow'],
    ['#/monitor', '调用监控 · MediaFlow'],
  ])('%s opens as %s', async (hash, title) => {
    window.history.replaceState(null, '', hash);
    render(<App />);
    await waitFor(() => expect(document.title).toBe(title));
  });
});
