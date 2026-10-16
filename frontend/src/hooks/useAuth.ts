import { useState, useCallback, useRef } from 'react';

const TOKEN_KEY = 'asr_token';

export function useAuth() {
  const [token, _setTokenState] = useState<string>(() => localStorage.getItem(TOKEN_KEY) || '');
  const authGenerationRef = useRef(0);
  const authPromptRef = useRef<{ generation: number; promise: Promise<string | null> } | null>(null);

  const setToken = useCallback((newToken: string) => {
    if (newToken) {
      localStorage.setItem(TOKEN_KEY, newToken);
      _setTokenState(newToken);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      _setTokenState('');
    }
    authGenerationRef.current += 1;
  }, []);

  const clearSession = useCallback(() => {
    setToken('');
    void fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => undefined);
  }, [setToken]);

  const authedFetch = useCallback(async (url: string, opts: RequestInit = {}): Promise<Response> => {
    const t = localStorage.getItem(TOKEN_KEY) || '';
    const authGeneration = authGenerationRef.current;
    const headers = new Headers(opts.headers || {});
    if (t) {
      headers.set('Authorization', `Bearer ${t}`);
    }

    const r = await fetch(url, { ...opts, headers });

    if (r.status === 401) {
      const currentToken = localStorage.getItem(TOKEN_KEY) || '';
      const retryWithToken = (authToken: string) => {
        const retryHeaders = new Headers(opts.headers || {});
        retryHeaders.set('Authorization', `Bearer ${authToken}`);
        return fetch(url, { ...opts, headers: retryHeaders });
      };

      if (authGenerationRef.current !== authGeneration || currentToken !== t) {
        if (currentToken) return retryWithToken(currentToken);
        return r;
      }

      let promptCycle = authPromptRef.current;
      if (!promptCycle || promptCycle.generation !== authGeneration) {
        promptCycle = {
          generation: authGeneration,
          promise: Promise.resolve().then(() => prompt('需要访问令牌（已启用鉴权）')),
        };
        authPromptRef.current = promptCycle;
        void promptCycle.promise.then(
          () => { if (authPromptRef.current === promptCycle) authPromptRef.current = null; },
          () => { if (authPromptRef.current === promptCycle) authPromptRef.current = null; },
        );
      }

      const tok = await promptCycle.promise;
      const latestToken = localStorage.getItem(TOKEN_KEY) || '';
      if (authGenerationRef.current !== authGeneration || latestToken !== t) {
        if (latestToken) return retryWithToken(latestToken);
        return r;
      }

      if (tok) {
        setToken(tok);
        return retryWithToken(tok);
      }
      clearSession();
    }
    return r;
  }, [clearSession, setToken]);

  const sseUrl = useCallback((path: string) => {
    const baseUrl = window.location.origin;
    // Authenticated HTTP requests establish the HttpOnly SSE cookie. Keeping
    // the access token out of the EventSource URL avoids leaking it to logs,
    // history, proxies, and observability tooling.
    return new URL(path, baseUrl).href;
  }, []);

  return {
    token,
    setToken,
    clearSession,
    authedFetch,
    sseUrl,
  };
}
