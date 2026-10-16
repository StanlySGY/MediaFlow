import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileTask } from './useFileTask';

const STORAGE_KEY = 'asr_file_task_id';

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  readonly close = vi.fn();
  onerror: ((event: Event) => void) | null = null;
  private messageListener: ((event: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === 'message') this.messageListener = listener as (event: MessageEvent) => void;
  }

  dispatchEvent(event: Event) {
    if (event.type === 'error') this.onerror?.(event);
    return true;
  }

  emit(payload: unknown) {
    this.messageListener?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(data),
}) as unknown as Response;

const activeInfo = {
  status: 'transcribing',
  progress: 0.4,
  total_segments: 5,
  finished_segments: 2,
};

const terminalInfo = {
  status: 'done',
  progress: 1,
  total_segments: 2,
  finished_segments: 2,
};

const finalResult = {
  status: 'done',
  duration: 12.8,
  text: 'final transcript',
  segments: [
    { segment_id: 1, start: 0, end: 6, text: 'final', elapsed_ms: 120 },
    { segment_id: 2, start: 6, end: 12.8, text: 'transcript', elapsed_ms: 180 },
  ],
};

const sseUrl = (path: string) => path;

beforeEach(() => {
  localStorage.clear();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useFileTask recovery', () => {
  it('restores a persisted active task and reconnects to its replayable event stream', async () => {
    localStorage.setItem(STORAGE_KEY, 'resume-task');
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/task/resume-task' || url === '/asr/file/resume-task') {
        return response(activeInfo);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(result.current.taskId).toBe('resume-task'));
    expect(result.current.taskStatus).toBe('transcribing');
    expect(result.current.taskProgress).toBe(0.4);
    expect(result.current.taskTotalSegs).toBe(5);
    expect(result.current.taskFinSegs).toBe(2);
    expect(MockEventSource.instances[0].url).toBe('/asr/file/resume-task/events');
    unmount();
  });

  it('hydrates the authoritative result when polling reaches terminal state after an SSE error', async () => {
    localStorage.setItem(STORAGE_KEY, 'complete-task');
    let resolvePoll!: (value: Response) => void;
    const pollResult = new Promise<Response>((resolve) => { resolvePoll = resolve; });
    const authedFetch = vi.fn((url: string) => {
      if (url === '/asr/task/complete-task') return Promise.resolve(response(activeInfo));
      if (url === '/asr/file/complete-task') return pollResult;
      if (url === '/asr/file/complete-task/result') return Promise.resolve(response(finalResult));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/asr/file/complete-task'));
    const eventSource = MockEventSource.instances[0];
    act(() => { eventSource.dispatchEvent(new Event('error')); });
    expect(eventSource.close).not.toHaveBeenCalled();

    await act(async () => { resolvePoll(response(terminalInfo)); });
    await waitFor(() => expect(result.current.fullText).toBe('final transcript'));

    expect(result.current.taskStatus).toBe('done');
    expect(result.current.taskProgress).toBe(1);
    expect(result.current.taskDuration).toBe('0m12s');
    expect(result.current.taskTotalSegs).toBe(2);
    expect(result.current.taskFinSegs).toBe(2);
    expect(result.current.segments).toEqual(finalResult.segments.map((segment) => ({
      ...segment,
      is_final: true,
      error: null,
    })));
    expect(authedFetch).toHaveBeenCalledWith('/asr/file/complete-task/result');
    expect(eventSource.close).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('resumes active history tasks without cancelling the task previously viewed', async () => {
    localStorage.setItem(STORAGE_KEY, 'current-task');
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/task/current-task' || url === '/asr/file/current-task') {
        return response(activeInfo);
      }
      if (url === '/asr/task/history-task') {
        return response({ ...activeInfo, progress: 0.6, finished_segments: 3 });
      }
      if (url === '/asr/file/history-task') {
        return response({ ...activeInfo, progress: 0.6, finished_segments: 3 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(result.current.taskId).toBe('current-task'));
    const previousSource = MockEventSource.instances[0];
    let loaded = false;
    await act(async () => { loaded = await result.current.loadHistoricalTask('history-task'); });

    expect(loaded).toBe(true);
    expect(result.current.taskId).toBe('history-task');
    expect(result.current.taskStatus).toBe('transcribing');
    expect(result.current.taskProgress).toBe(0.6);
    expect(result.current.taskFinSegs).toBe(3);
    expect(MockEventSource.instances[1].url).toBe('/asr/file/history-task/events');
    expect(previousSource.close).toHaveBeenCalledTimes(1);
    expect(authedFetch.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('history-task');
    unmount();
  });

  it('loads a terminal history task from its result endpoint', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/task/history-done') return response(terminalInfo);
      if (url === '/asr/task/history-done/result') return response(finalResult);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    let loaded = false;
    await act(async () => { loaded = await result.current.loadHistoricalTask('history-done'); });

    expect(loaded).toBe(true);
    expect(result.current.taskId).toBe('history-done');
    expect(result.current.taskStatus).toBe('done');
    expect(result.current.fullText).toBe('final transcript');
    expect(result.current.taskTotalSegs).toBe(2);
    expect(authedFetch).toHaveBeenCalledWith('/asr/task/history-done');
    expect(authedFetch).toHaveBeenCalledWith('/asr/task/history-done/result');
    unmount();
  });

  it('clears a persisted ID when the server confirms that task has expired', async () => {
    localStorage.setItem(STORAGE_KEY, 'expired-task');
    const authedFetch = vi.fn(async () => response({}, 404));
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(result.current.taskId).toBeNull();
    expect(MockEventSource.instances).toHaveLength(0);
    unmount();
  });

  it('retries startup recovery after a transient server failure', async () => {
    localStorage.setItem(STORAGE_KEY, 'retry-task');
    let statusCalls = 0;
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/task/retry-task') {
        statusCalls += 1;
        if (statusCalls === 1) {
          return response({}, 503);
        }
        return response(activeInfo);
      }
      if (url === '/asr/file/retry-task') return response(activeInfo);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(result.current.taskId).toBe('retry-task'));
    expect(authedFetch.mock.calls.filter(([url]) => url === '/asr/task/retry-task')).toHaveLength(2);
    expect(result.current.taskStatus).toBe('transcribing');
    unmount();
  });

  it('ignores a restore response that completes after an explicit reset', async () => {
    localStorage.setItem(STORAGE_KEY, 'stale-task');
    let resolveStatus!: (value: Response) => void;
    const pendingStatus = new Promise<Response>((resolve) => { resolveStatus = resolve; });
    const authedFetch = vi.fn(() => pendingStatus);
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/asr/task/stale-task'));
    await act(async () => { await result.current.resetTask(); });
    await act(async () => { resolveStatus(response(activeInfo)); });

    expect(result.current.taskId).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(MockEventSource.instances).toHaveLength(0);
    unmount();
  });

  it('persists a task ID only after the upload request succeeds', async () => {
    class MockXhr {
      static instance: MockXhr;
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: ((event: ProgressEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 201;
      responseText = JSON.stringify({ task_id: 'uploaded-task' });
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn();
      abort = vi.fn();

      constructor() { MockXhr.instance = this; }
    }
    vi.stubGlobal('XMLHttpRequest', MockXhr);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/uploaded-task') return response(activeInfo);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));
    const file = new File(['audio'], 'sample.wav', { type: 'audio/wav' });
    let upload!: Promise<void>;

    act(() => { upload = result.current.handleFileSelect(file); });
    await waitFor(() => expect(MockXhr.instance).toBeDefined());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    await act(async () => {
      MockXhr.instance.onload?.(new ProgressEvent('load'));
      await upload;
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('uploaded-task');
    unmount();
  });
});
