import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

// App probes /auth/info, /asr/config and /asr/health on mount — stub them so it renders.
function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/auth/info')) return json({ auth_required: false });
    if (u.includes('/asr/config')) return json({ provider: 'openai_compat', api_key_set: true });
    if (u.includes('/asr/health')) return json({ ok: true, configured: true });
    return json({});
  });
}

describe('<App /> smoke', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch());
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the upload view and hides the beginner guide once configured', async () => {
    render(<App />);
    // The dropzone is the single upload entry point.
    expect(await screen.findByText(/点击选择文件/)).toBeInTheDocument();
    // api_key_set is true for this mock, so the guide is not needed.
    await waitFor(() => expect(screen.queryByText('快速上手')).not.toBeInTheDocument());
  });

  it('does not follow a canceled startup token prompt with another prompt', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/auth/info')) return json({ auth_required: true });
      return { ok: false, status: 401 } as Response;
    });
    const promptMock = vi.fn(() => null);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', promptMock);

    render(<App />);

    expect(await screen.findByText('快速上手')).toBeInTheDocument();
    await waitFor(() => expect(promptMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/auth/info');
  });
});
