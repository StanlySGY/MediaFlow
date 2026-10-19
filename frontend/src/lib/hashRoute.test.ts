import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, parseHash, readView, writeQuery, writeView } from './hashRoute';

const setHash = (hash: string) => {
  window.location.hash = hash;
};

describe('hashRoute', () => {
  beforeEach(() => {
    setHash('');
  });

  it('reads the view out of the path fragment', () => {
    expect(parseHash('#/history').view).toBe('history');
    expect(parseHash('#/realtime?q=会议').view).toBe('realtime');
  });

  it('falls back to the default view for an empty or unknown fragment', () => {
    expect(parseHash('').view).toBe(DEFAULT_VIEW);
    expect(parseHash('#/nonsense').view).toBe(DEFAULT_VIEW);
    expect(parseHash('#tasks?x=1').view).toBe('tasks');
  });

  it('accepts the older ?view= spelling and keeps it out of the query', () => {
    const route = parseHash('?view=monitor&job=1');
    expect(route.view).toBe('monitor');
    expect(route.query.get('view')).toBeNull();
    expect(route.query.get('job')).toBe('1');
  });

  it('writes a view as a new history entry and filters as a replace', () => {
    const lengthBefore = window.history.length;
    writeView('history');
    expect(window.location.hash).toBe('#/history');
    expect(window.history.length).toBe(lengthBefore + 1);

    // Filters must not bury the back button in one entry per keystroke.
    const afterNav = window.history.length;
    writeQuery({ status: 'failed' });
    writeQuery({ status: 'failed', page: 2 });
    expect(window.history.length).toBe(afterNav);
    expect(window.location.hash).toBe('#/history?status=failed&page=2');
  });

  it('drops empty and zero-valued params so fragments stay short', () => {
    setHash('#/history');
    writeQuery({ q: '', status: 'done', page: 0 });
    expect(window.location.hash).toBe('#/history?status=done');
  });

  it('reads the current view back out of window.location', () => {
    setHash('#/concat');
    expect(readView()).toBe('concat');
  });
});
