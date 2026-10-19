import { useState, useCallback, useRef } from 'react';

const TOKEN_KEY = 'asr_token';

export type TokenRequestReason = 'required' | 'manual';

export interface TokenRequest {
  reason: TokenRequestReason;
}

export function useAuth() {
  const [token, _setTokenState] = useState<string>(() => localStorage.getItem(TOKEN_KEY) || '');
  const authGenerationRef = useRef(0);
  const authPromptRef = useRef<{ generation: number; promise: Promise<string | null> } | null>(null);
  const [tokenRequest, setTokenRequest] = useState<TokenRequest | null>(null);
  const tokenResolverRef = useRef<((token: string | null) => void) | null>(null);

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
        // One in-app dialog per auth generation, resolved by submitToken /
        // cancelTokenRequest below. It replaces window.prompt, which blocked
        // the whole page (uploads included) and put the access token into a
        // browser-chrome input with no masking.
        promptCycle = {
          generation: authGeneration,
          promise: new Promise<string | null>((resolve) => {
            tokenResolverRef.current = resolve;
          }),
        };
        authPromptRef.current = promptCycle;
        setTokenRequest({ reason: 'required' });
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

  const openTokenRequest = useCallback((reason: TokenRequestReason = 'manual') => {
    setTokenRequest((prev) => prev || { reason });
  }, []);

  const submitToken = useCallback(
    async (value: string) => {
      const nextToken = value.trim();
      const resolver = tokenResolverRef.current;
      tokenResolverRef.current = null;
      setTokenRequest(null);
      // Persist first: a pending authedFetch retries against localStorage, and
      // its generation guard only re-reads the token after this resolves.
      if (nextToken) setToken(nextToken);
      else clearSession();
      if (resolver) resolver(nextToken);
    },
    [clearSession, setToken],
  );

  const cancelTokenRequest = useCallback(() => {
    const resolver = tokenResolverRef.current;
    tokenResolverRef.current = null;
    setTokenRequest(null);
    resolver?.(null);
  }, []);

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
    tokenRequest,
    openTokenRequest,
    submitToken,
    cancelTokenRequest,
  };
}
