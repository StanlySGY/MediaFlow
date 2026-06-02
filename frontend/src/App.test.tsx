import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

// App probes /auth/info, /asr/config and /asr/ping on mount — stub them so it renders.
function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/auth/info')) return json({ auth_required: false });
    if (u.includes('/asr/config')) return json({ provider: 'openai_compat', api_key_set: true });
    if (u.includes('/asr/ping')) return json({ ok: true });
    return json({});
  });
}

describe('<App /> smoke', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch());
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the onboarding guide and upload view', async () => {
    render(<App />);
    expect(await screen.findByText('快速上手')).toBeInTheDocument();
    expect(screen.getByText('上传音频')).toBeInTheDocument();
  });
});
