/**
 * Hash-based URL state.
 *
 * The console is served by StaticFiles mounted at "/" with no server-side SPA
 * rewrite (app/main.py), so a path like /history?status=failed is a real request
 * for a file that does not exist and 404s on refresh. The fragment is the only
 * part of the URL the server never sees, so every piece of view state that is
 * worth a link or a refresh has to live after the "#".
 *
 * Shape: #/history?q=会议&status=done&page=2
 */

/** View ids, kept in sync with Sidebar's nav items and App's routes. */
export const VIEWS = ['tasks', 'realtime', 'history', 'concat', 'config', 'monitor', 'api-debug'] as const;

export const DEFAULT_VIEW = 'tasks';

const VIEW_PARAM = 'view';

const isView = (value: string | null): value is (typeof VIEWS)[number] =>
  !!value && (VIEWS as readonly string[]).includes(value);

/**
 * Accept both the modern `#/history?...` shape and a plain `?view=history`
 * query, because bookmarked links from before this helper existed (and a
 * hand-written link to "/" with a query) should still land on the right view.
 */
export const parseHash = (hash: string): { view: string; query: URLSearchParams } => {
  const raw = (hash || '').replace(/^#/, '');
  const [path, search = ''] = raw.split('?');
  const query = new URLSearchParams(search);
  const fromPath = path.replace(/^\//, '');
  const view = isView(fromPath)
    ? fromPath
    : isView(query.get(VIEW_PARAM))
      ? (query.get(VIEW_PARAM) as string)
      : DEFAULT_VIEW;
  // The view is encoded in the path; keep it out of the query so the two
  // accepted spellings never disagree with each other.
  query.delete(VIEW_PARAM);
  return { view, query };
};

const current = () => parseHash(typeof window === 'undefined' ? '' : window.location.hash);

export const readView = () => current().view;
export const readQuery = () => current().query;

const applyRoute = (view: string, query: URLSearchParams, replace: boolean) => {
  const search = query.toString();
  const hash = `#/${view}${search ? `?${search}` : ''}`;
  try {
    if (hash === window.location.hash) return;
    if (replace) {
      window.history.replaceState(null, '', hash);
    } else {
      window.location.hash = hash;
    }
  } catch {
    // A browser that refuses history writes (or a hash that equals the current
    // one) must not break navigation — the view state itself is React state.
  }
};

/**
 * Switch views. This one pushes a history entry so the browser back button
 * walks the console the way it walks any other page.
 */
export const writeView = (view: string) => applyRoute(isView(view) ? view : DEFAULT_VIEW, new URLSearchParams(), false);

/**
 * Record in-page state (filters, page) for the view already on screen. These
 * use replaceState: a filter text field would otherwise bury the back button in
 * one entry per keystroke.
 */
export const writeQuery = (values: Record<string, string | number | undefined>) => {
  const { view, query } = current();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '' || value === 0) query.delete(key);
    else query.set(key, String(value));
  }
  applyRoute(view, query, true);
};
