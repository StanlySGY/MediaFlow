import { useState, useCallback } from 'react';

const TOKEN_KEY = 'asr_token';

export function useAuth() {
  const [token, _setTokenState] = useState<string>(() => localStorage.getItem(TOKEN_KEY) || '');

  const setToken = useCallback((newToken: string) => {
    if (newToken) {
      localStorage.setItem(TOKEN_KEY, newToken);
      _setTokenState(newToken);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      _setTokenState('');
    }
  }, []);

  const authedFetch = useCallback(async (url: string, opts: RequestInit = {}): Promise<Response> => {
    const t = localStorage.getItem(TOKEN_KEY) || '';
    const headers = new Headers(opts.headers || {});
    if (t) {
      headers.set('Authorization', `Bearer ${t}`);
    }
    
    let r = await fetch(url, { ...opts, headers });
    
    if (r.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      _setTokenState('');
      const tok = prompt('需要访问令牌（已启用鉴权）');
      if (tok) {
        localStorage.setItem(TOKEN_KEY, tok);
        _setTokenState(tok);
        
        // Retry fetch with new token
        const retryHeaders = new Headers(opts.headers || {});
        retryHeaders.set('Authorization', `Bearer ${tok}`);
        r = await fetch(url, { ...opts, headers: retryHeaders });
      }
    }
    return r;
  }, []);

  const sseUrl = useCallback((path: string) => {
    const t = localStorage.getItem(TOKEN_KEY) || '';
    return t ? `${path}?token=${encodeURIComponent(t)}` : path;
  }, []);

  return {
    token,
    setToken,
    authedFetch,
    sseUrl,
  };
}
