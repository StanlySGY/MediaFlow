import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from '../lib/download';
import { useFileTask } from './useFileTask';

vi.mock('../lib/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/download')>()),
  downloadBlob: vi.fn(),
}));

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
  it('only confirms copying the transcript after clipboard success and explains permission failures', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { result, unmount } = renderHook(() => useFileTask(vi.fn(), sseUrl));
    act(() => result.current.setFullText('A verified transcript'));

    await act(async () => { await result.current.handleCopy(); });
    expect(writeText).toHaveBeenCalledWith('A verified transcript');
    expect(result.current.copied).toBe(true);
    expect(result.current.copyError).toBeNull();

    writeText.mockRejectedValueOnce(new Error('permission denied'));
    await act(async () => { await result.current.handleCopy(); });
    expect(result.current.copied).toBe(false);
    expect(result.current.copyError).toContain('无法访问剪贴板');
    unmount();
  });

  it('restores a persisted active task and reconnects to its replayable event stream', async () => {
    localStorage.setItem(STORAGE_KEY, 'resume-task');
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/resume-task') return response(activeInfo);
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
    let statusReads = 0;
    const authedFetch = vi.fn((url: string) => {
      if (url === '/asr/file/complete-task') {
        statusReads += 1;
        return statusReads === 1 ? Promise.resolve(response(activeInfo)) : pollResult;
      }
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
      if (url === '/asr/file/current-task') return response(activeInfo);
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
      if (url === '/asr/file/history-done') return response(terminalInfo);
      if (url === '/asr/file/history-done/result') return response(finalResult);
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
    expect(authedFetch).toHaveBeenCalledWith('/asr/file/history-done');
    expect(authedFetch).toHaveBeenCalledWith('/asr/file/history-done/result');
    unmount();
  });

  it('undoes a segment edit and hands the export back to the server once fully undone', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/history-done') return response(terminalInfo);
      if (url === '/asr/file/history-done/result') return response(finalResult);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await act(async () => { await result.current.loadHistoricalTask('history-done'); });
    expect(result.current.undoDepth).toBe(0);

    act(() => result.current.handleEditSegment(1, 'edited first'));
    act(() => result.current.handleEditSegment(2, 'edited second'));
    expect(result.current.segments.map(s => s.text)).toEqual(['edited first', 'edited second']);
    expect(result.current.undoDepth).toBe(2);
    expect(result.current.segmentsEdited).toBe(true);

    act(() => result.current.undoEdit());
    expect(result.current.segments.map(s => s.text)).toEqual(['edited first', 'transcript']);
    expect(result.current.undoDepth).toBe(1);
    // Still proofread, so the local SRT builder stays in charge.
    expect(result.current.segmentsEdited).toBe(true);

    act(() => result.current.undoEdit());
    expect(result.current.segments.map(s => s.text)).toEqual(['final', 'transcript']);
    expect(result.current.undoDepth).toBe(0);
    // Back to pristine: the server's subtitle (word grouping, de-duplication)
    // is the better export again.
    expect(result.current.segmentsEdited).toBe(false);

    // Nothing left to undo must be a no-op, not an error.
    act(() => result.current.undoEdit());
    expect(result.current.segments.map(s => s.text)).toEqual(['final', 'transcript']);
    unmount();
  });

  it('carries a segment edit into the full text used by TXT and the zip bundle', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/history-done') return response(terminalInfo);
      if (url === '/asr/file/history-done/result') return response(finalResult);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await act(async () => { await result.current.loadHistoricalTask('history-done'); });
    expect(result.current.fullText).toBe('final transcript');

    act(() => result.current.handleEditSegment(1, '校对后的'));
    // Same rule as the backend's _join_words: a space is inserted only when the
    // character before the boundary is not CJK, so "的" + "transcript" stays
    // glued. Agreeing with the server matters — this text is what TXT and the
    // zip bundle carry.
    expect(result.current.fullText).toBe('校对后的transcript');

    act(() => result.current.undoEdit());
    expect(result.current.fullText).toBe('final transcript');
    unmount();
  });

  it('does not overwrite a full text the user typed themselves', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/history-done') return response(terminalInfo);
      if (url === '/asr/file/history-done/result') return response(finalResult);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await act(async () => { await result.current.loadHistoricalTask('history-done'); });
    act(() => result.current.setFullText('我自己改过的全文'));
    act(() => result.current.handleEditSegment(1, '校对后的'));

    expect(result.current.fullText).toBe('我自己改过的全文');
    unmount();
  });

  it('reports a conflict when a typed full text and a segment edit disagree, and syncing resolves it', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/history-done') return response(terminalInfo);
      if (url === '/asr/file/history-done/result') return response(finalResult);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await act(async () => { await result.current.loadHistoricalTask('history-done'); });
    expect(result.current.textConflict).toBe(false);

    // Two proofreading surfaces, two exports following them: TXT follows the
    // full text, SRT/VTT follow the segments. Typing over the full text and
    // then correcting a segment pulls them apart, and the UI has to know.
    act(() => result.current.setFullText('整体改写过的文稿'));
    act(() => result.current.handleEditSegment(1, '校对后的'));
    expect(result.current.fullText).toBe('整体改写过的文稿');
    expect(result.current.textConflict).toBe(true);

    // Syncing moves the full text to the side that can carry timestamps.
    act(() => result.current.syncFullTextFromSegments());
    expect(result.current.fullText).toBe('校对后的transcript');
    expect(result.current.textConflict).toBe(false);
    unmount();
  });

  it('keeps an untouched full text out of the conflict report', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/history-done') return response(terminalInfo);
      if (url === '/asr/file/history-done/result') return response(finalResult);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await act(async () => { await result.current.loadHistoricalTask('history-done'); });
    // A segment edit alone moves both surfaces together — no disagreement to show.
    act(() => result.current.handleEditSegment(1, '校对后的'));
    expect(result.current.fullText).toBe('校对后的transcript');
    expect(result.current.textConflict).toBe(false);
    unmount();
  });

  it('does not record an undo step for a commit that changes nothing', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/history-done') return response(terminalInfo);
      if (url === '/asr/file/history-done/result') return response(finalResult);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await act(async () => { await result.current.loadHistoricalTask('history-done'); });
    act(() => result.current.handleEditSegment(1, 'final'));

    expect(result.current.undoDepth).toBe(0);
    expect(result.current.segmentsEdited).toBe(false);
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
      if (url === '/asr/file/retry-task') {
        statusCalls += 1;
        if (statusCalls === 1) {
          return response({}, 503);
        }
        return response(activeInfo);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(result.current.taskId).toBe('retry-task'));
    const statusReads = authedFetch.mock.calls.filter(([url]) => url === '/asr/file/retry-task');
    // attempt 1 answers 503, attempt 2 succeeds; polling reuses the same URL so
    // only the presence of the retry is observable here.
    expect(statusReads.length).toBeGreaterThanOrEqual(2);
    expect(result.current.taskStatus).toBe('transcribing');
    expect(MockEventSource.instances[0]?.url).toBe('/asr/file/retry-task/events');
    unmount();
  });

  it('ignores a restore response that completes after an explicit reset', async () => {
    localStorage.setItem(STORAGE_KEY, 'stale-task');
    let resolveStatus!: (value: Response) => void;
    const pendingStatus = new Promise<Response>((resolve) => { resolveStatus = resolve; });
    const authedFetch = vi.fn(() => pendingStatus);
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/asr/file/stale-task'));
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

describe('useFileTask bundle export', () => {
  it('archives the local audio with the subtitle and the text', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('XMLHttpRequest', MockXHR);
    // MockXHR always reports task_id "preflight-task".
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/preflight-task') return response(activeInfo);
      if (url === '/asr/file/preflight-task/subtitle?format=srt') {
        return { ok: true, status: 200, text: async () => '1\n00:00:00,000 --> 00:00:06,000\n你好\n' } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    // No upload has happened yet, so there is no audio to archive.
    expect(result.current.hasLocalMedia).toBe(false);
    expect(await result.current.downloadBundle()).toBe(false);

    let upload!: Promise<void>;
    act(() => { upload = result.current.handleFileSelect(new File(['audio'], 'meeting.wav', { type: 'audio/wav' })); });
    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    await act(async () => { await upload; });
    expect(result.current.hasLocalMedia).toBe(true);

    expect(await result.current.downloadBundle()).toBe(true);
    const [name, blob] = vi.mocked(downloadBlob).mock.calls.at(-1)!;
    expect(name).toBe('meeting-prefligh.zip');
    const bytes = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
    // Stored entries keep their names in the central directory.
    expect(bytes).toContain('meeting.wav');
    expect(bytes).toContain('meeting.srt');
    expect(bytes).toContain('meeting.txt');
    expect(bytes).toContain('00:00:00,000 --> 00:00:06,000');
    unmount();
  });
});

class MockXHR {
  static instances: MockXHR[] = [];
  status = 200;
  responseText = JSON.stringify({ task_id: 'preflight-task' });
  readonly open = vi.fn();
  readonly abort = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readonly send = vi.fn(() => {
    // The hook awaits this promise, so it has to settle like a real upload.
    setTimeout(() => this.onload?.(), 0);
  });

  constructor() {
    MockXHR.instances.push(this);
  }
}

describe('useFileTask upload preflight', () => {
  const limits = { maxBytes: 2 * 1024 ** 3, allowedExts: ['.mp3', '.wav', '.mp4'] };
  // A real File, since the accepted path goes on to build an object URL and a
  // FormData entry from it. Size is overridden: the preflight reads it before
  // any byte is read, and no test should hold gigabytes in memory.
  const pickedFile = (name: string, size: number) => {
    const file = new File(['x'], name, { type: name.endsWith('.mp4') ? 'video/mp4' : 'audio/wav' });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', MockXHR);
  });

  it('rejects an unsupported extension without starting an upload', async () => {
    const authedFetch = vi.fn(async () => response({}));
    const { result } = renderHook(() => useFileTask(authedFetch, sseUrl, limits));

    await act(async () => { await result.current.handleFileSelect(pickedFile('report.zip', 1024)); });

    expect(result.current.taskError).toContain('.zip');
    expect(result.current.taskError).toContain('mp3 / wav / mp4');
    expect(MockXHR.instances).toHaveLength(0);
    expect(result.current.taskStatus).toBe('—');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('rejects an oversize file and leaves the task currently on screen intact', async () => {
    localStorage.setItem(STORAGE_KEY, 'running-task');
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/running-task') return response(activeInfo);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl, limits));
    await waitFor(() => expect(result.current.taskStatus).toBe('transcribing'));

    await act(async () => {
      await result.current.handleFileSelect(pickedFile('huge.wav', 3 * 1024 ** 3));
    });

    // A mistyped pick used to cancel the running task first, then fail minutes
    // later with a 413 mid-transfer. Neither happens now.
    expect(result.current.taskError).toContain('3 GB');
    expect(result.current.taskStatus).toBe('transcribing');
    expect(result.current.taskProgress).toBe(0.4);
    expect(result.current.taskId).toBe('running-task');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('running-task');
    expect(MockXHR.instances).toHaveLength(0);
    expect(authedFetch.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
    unmount();
  });

  it('lets an acceptable file through to the upload', async () => {
    const authedFetch = vi.fn(async () => response({}));
    const { result } = renderHook(() => useFileTask(authedFetch, sseUrl, limits));

    await act(async () => {
      await result.current.handleFileSelect(pickedFile('ok.mp4', 1024));
    });

    expect(result.current.taskError).toBeNull();
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0].open).toHaveBeenCalledWith('POST', '/asr/file');
  });

  it('skips the size check when the server has not reported a limit yet', async () => {
    const authedFetch = vi.fn(async () => response({}));
    const { result } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await act(async () => {
      await result.current.handleFileSelect(pickedFile('unknown-size.wav', 9 * 1024 ** 3));
    });

    expect(result.current.taskError).toBeNull();
    expect(MockXHR.instances).toHaveLength(1);
  });
});

describe('useFileTask failure protocol', () => {
  beforeEach(() => { MockXHR.instances = []; });

  const failedResult = {
    status: 'failed',
    duration: 0,
    text: '',
    segments: [],
    error: '上游 ASR 拒绝了这段音频',
    error_code: 'audio_invalid',
    hint: '换个格式或降低码率后重新提交',
    retryable: false,
  };
  const interruptedResult = {
    ...failedResult,
    error: '服务在任务完成前重启，任务未继续执行',
    error_code: 'interrupted',
    hint: '请重新提交该文件',
    retryable: true,
  };

  it('surfaces the server error fields and refuses to offer a retry for a permanent failure', async () => {
    localStorage.setItem(STORAGE_KEY, 'broken-task');
    const authedFetch = vi.fn(async (url: string) => {
      // Startup recovery reads the task by its canonical id; the live stream
      // poll and the terminal hydrate use the /file spelling.
      if (url === '/asr/file/broken-task') {
        return response({ ...failedResult, progress: 0.2 });
      }
      if (url === '/asr/file/broken-task/result') return response(failedResult);
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));

    await waitFor(() => expect(result.current.taskError).toBe('上游 ASR 拒绝了这段音频'));
    expect(result.current.taskErrorHint).toBe('换个格式或降低码率后重新提交');
    expect(result.current.taskErrorCode).toBe('audio_invalid');
    // Nothing to resend in this tab anyway, and the server said resending would not help.
    expect(result.current.canRetryTask).toBe(false);
    unmount();
  });

  it('marks an interrupted task retryable once the file that failed is still on hand', async () => {
    vi.stubGlobal('XMLHttpRequest', MockXHR);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/file/preflight-task') return response({ ...interruptedResult, progress: 0.2 });
      if (url === '/asr/file/preflight-task/result') return response(interruptedResult);
      return response(activeInfo);
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));
    const file = new File(['audio'], 'sample.wav', { type: 'audio/wav' });

    await act(async () => { await result.current.handleFileSelect(file); });
    await waitFor(() => expect(result.current.taskStatus).toBe('failed'));
    expect(result.current.taskError).toBe('服务在任务完成前重启，任务未继续执行');
    expect(result.current.canRetryTask).toBe(true);

    await act(async () => { await result.current.retryTask(); });
    // The retry is a fresh submit of the same file, not a poke at the dead task.
    expect(MockXHR.instances).toHaveLength(2);
    expect(MockXHR.instances[1].open).toHaveBeenCalledWith('POST', '/asr/file');
    unmount();
  });

  it('aborts an in-flight task without throwing away the workspace', async () => {
    localStorage.setItem(STORAGE_KEY, 'active-task');
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/task/active-task/cancel') return response({ ok: true, status: 'accepted' });
      if (url === '/asr/file/active-task') return response(activeInfo);
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    const { result, unmount } = renderHook(() => useFileTask(authedFetch, sseUrl));
    await waitFor(() => expect(result.current.taskId).toBe('active-task'));

    const aborted = await act(async () => result.current.abortTask());
    expect(aborted).toBe(true);
    expect(authedFetch).toHaveBeenCalledWith('/asr/task/active-task/cancel', { method: 'POST' });
    // Cancelling is not clearing: the task id and its segments stay on screen so
    // whatever was already recognized can still be exported.
    expect(result.current.taskId).toBe('active-task');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('active-task');
    unmount();
  });
});
