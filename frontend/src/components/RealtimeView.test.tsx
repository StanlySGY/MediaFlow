import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../lib/download';
import { RealtimeView } from './RealtimeView';

vi.mock('../lib/download', () => ({ downloadFile: vi.fn() }));

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, handler: (event: MessageEvent) => void) {
    this.listeners[event] = [...(this.listeners[event] || []), handler];
  }

  emit(event: string, data: unknown) {
    for (const handler of this.listeners[event] || []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  emitOpen() {
    this.onopen?.();
  }

  emitError() {
    this.onerror?.();
  }

  close() {
    this.closeCalls += 1;
  }
}

const textDeltaEvent = (sessionId: string, start: number, text: string) => ({
  type: 'text',
  stream: 'realtime',
  id: sessionId,
  session_id: sessionId,
  text: '',
  delta: { start, remove: 0, text },
  is_final: start > 0,
  source_event: start > 0 ? 'final' : 'online',
});

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn((mime: string) => mime.startsWith('audio/webm'));
  state = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(public stream: MediaStream, public options?: MediaRecorderOptions) {
    MockMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

describe('<RealtimeView /> browser recorder', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    MockMediaRecorder.instances = [];
    vi.mocked(downloadFile).mockClear();
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts browser recording and shows realtime text on the white board', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-1' });
      if (url === '/asr/realtime/sess-1') return json({ bytes_received: 128 });
      if (url === '/asr/realtime/sess-1/audio') return json({ ok: true });
      return json({});
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);

    expect(screen.getByRole('button', { name: '复制录音文稿' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下载录音 TXT' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));

    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(screen.getByText('录音中')).toBeInTheDocument();
    expect(MockEventSource.instances[0].url).toBe('/asr/realtime/sess-1/events');
    const sessionBody = JSON.parse(String(authedFetch.mock.calls[0][1]?.body));
    expect(sessionBody.format).toBe('webm');

    // Under the incremental contract the realtime stream sends empty `text`
    // plus a structured splice `delta`; the view rebuilds the transcript from
    // the deltas against a committed baseline (not from the empty text).
    act(() => {
      MockEventSource.instances[0].emit('message', {
        type: 'text',
        stream: 'realtime',
        id: 'sess-1',
        session_id: 'sess-1',
        text: '',
        delta: { start: 0, remove: 0, text: '你好，正在识别。' },
        is_final: false,
        source_event: 'online',
      });
    });

    expect(await screen.findByText('你好，正在识别。')).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0].emit('message', {
        type: 'text',
        stream: 'realtime',
        id: 'sess-1',
        session_id: 'sess-1',
        text: '',
        delta: { start: 1, remove: 2, text: '😃' },
        is_final: true,
        source_event: 'final',
      });
    });

    expect(await screen.findByText('你😃正在识别。')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '复制录音文稿' }));
    expect(clipboardWriteText).toHaveBeenCalledWith('你😃正在识别。');
    expect(await screen.findByRole('status')).toHaveTextContent('文稿已复制到剪贴板');

    clipboardWriteText.mockRejectedValueOnce(new Error('permission denied'));
    await userEvent.click(screen.getByRole('button', { name: '复制录音文稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法访问剪贴板，文稿仍保留在屏幕上');
    expect(screen.getByText('你😃正在识别。')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下载录音 TXT' }));
    expect(downloadFile).toHaveBeenCalledWith(
      'realtime-recording.txt',
      '你😃正在识别。',
      'text/plain;charset=utf-8',
    );

    act(() => {
      MockEventSource.instances[0].emit('message', {
        type: 'done',
        stream: 'realtime',
        id: 'sess-1',
        session_id: 'sess-1',
        text: '',
        delta: null,
        is_final: true,
      });
    });
    expect(await screen.findByText('识别完成')).toBeInTheDocument();
  });

  it('copies and downloads the reconstructed advanced-session transcript, not event deltas', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'manual-1' });
      return json({ ok: true });
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    await userEvent.click(screen.getByRole('button', {
      name: '高级设置 · 手动会话、文件模拟、事件日志',
    }));
    await userEvent.click(screen.getByRole('button', { name: '创建会话' }));

    const copyButton = await screen.findByRole('button', { name: '复制会话文稿' });
    expect(copyButton).toBeDisabled();
    expect(screen.getByRole('button', { name: '下载会话 TXT' })).toBeDisabled();

    act(() => {
      MockEventSource.instances[0].emit('message', {
        type: 'text',
        stream: 'realtime',
        id: 'manual-1',
        session_id: 'manual-1',
        text: '',
        delta: { start: 0, remove: 0, text: '模拟转写旧稿' },
        is_final: false,
        source_event: 'online',
      });
      MockEventSource.instances[0].emit('message', {
        type: 'text',
        stream: 'realtime',
        id: 'manual-1',
        session_id: 'manual-1',
        text: '',
        delta: { start: 4, remove: 2, text: '新稿' },
        is_final: true,
        source_event: 'final',
      });
    });

    expect(await screen.findByText('模拟转写新稿')).toBeInTheDocument();
    await userEvent.click(copyButton);
    expect(clipboardWriteText).toHaveBeenCalledWith('模拟转写新稿');
    expect(await screen.findByRole('status')).toHaveTextContent('会话文稿已复制到剪贴板');

    await userEvent.click(screen.getByRole('button', { name: '下载会话 TXT' }));
    expect(downloadFile).toHaveBeenCalledWith(
      'realtime-session.txt',
      '模拟转写新稿',
      'text/plain;charset=utf-8',
    );
  });

  it('keeps browser recording active and rebuilds replay after a transient SSE error', async () => {
    const deleteRequests: string[] = [];
    const authedFetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') deleteRequests.push(url);
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-reconnect' });
      return json({ ok: true });
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));

    const source = MockEventSource.instances[0];
    act(() => source.emitOpen());
    act(() => {
      source.emit('message', textDeltaEvent('sess-reconnect', 0, '你好'));
      source.emit('message', textDeltaEvent('sess-reconnect', 2, '世界'));
    });
    expect(await screen.findByText('你好世界')).toBeInTheDocument();

    act(() => source.emitError());
    expect(screen.getByText('录音中')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('实时结果连接中断，正在重新连接');
    expect(source.closeCalls).toBe(0);
    expect(deleteRequests).toEqual([]);

    act(() => source.emitOpen());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => {
      source.emit('message', textDeltaEvent('sess-reconnect', 0, '你好'));
      source.emit('message', textDeltaEvent('sess-reconnect', 2, '世界'));
    });

    expect(await screen.findByText('你好世界')).toBeInTheDocument();
    expect(screen.getAllByText('你好世界')).toHaveLength(1);
    expect(screen.getByText('录音中')).toBeInTheDocument();
    expect(source.closeCalls).toBe(0);
    expect(deleteRequests).toEqual([]);
  });

  it('keeps an advanced session active and replaces replayed event rows after reconnect', async () => {
    const deleteRequests: string[] = [];
    const authedFetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') deleteRequests.push(url);
      if (url === '/asr/realtime/session') return json({ session_id: 'manual-reconnect' });
      return json({ ok: true });
    });

    const { container } = render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    await userEvent.click(screen.getByRole('button', {
      name: '高级设置 · 手动会话、文件模拟、事件日志',
    }));
    await userEvent.click(screen.getByRole('button', { name: '创建会话' }));

    const source = MockEventSource.instances[0];
    act(() => source.emitOpen());
    act(() => {
      source.emit('message', textDeltaEvent('manual-reconnect', 0, '你好'));
      source.emit('message', textDeltaEvent('manual-reconnect', 2, '世界'));
    });
    expect(await screen.findByText('你好世界')).toBeInTheDocument();
    expect(screen.getByText('2 条')).toBeInTheDocument();

    act(() => source.emitError());
    expect(screen.getByText('会话进行中')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('事件流连接中断，正在重新连接');
    expect(source.closeCalls).toBe(0);
    expect(deleteRequests).toEqual([]);

    act(() => source.emitOpen());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => {
      source.emit('message', textDeltaEvent('manual-reconnect', 0, '你好'));
      source.emit('message', textDeltaEvent('manual-reconnect', 2, '世界'));
    });

    expect(await screen.findByText('2 条')).toBeInTheDocument();
    expect(container.querySelectorAll('.ev')).toHaveLength(2);
    expect(screen.getAllByText('你好世界')).toHaveLength(1);
    expect(screen.getByText('会话进行中')).toBeInTheDocument();
    expect(source.closeCalls).toBe(0);
    expect(deleteRequests).toEqual([]);
  });

  it('enters error on SSE failure and can recover by starting again', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: `sess-${MockEventSource.instances.length + 1}` });
      return json({ ok: true });
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));
    expect(screen.getByText('录音中')).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0].emit('message', {
        type: 'error',
        stream: 'realtime',
        id: 'sess-1',
        session_id: 'sess-1',
        text: '',
        delta: null,
        is_final: false,
        error: 'upstream failed',
      });
    });
    expect(await screen.findByText('发生错误')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));
    expect(screen.getByText('录音中')).toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(2);

    // Starting a new session stops the old recorder. Its stale onstop callback
    // must not move the new session back to processing or upload a final marker.
    const audioCalls = authedFetch.mock.calls.filter(([url]) => String(url).includes('/audio'));
    expect(audioCalls).toHaveLength(0);
    act(() => MockMediaRecorder.instances[0].onstop?.());
    expect(screen.getByText('录音中')).toBeInTheDocument();
    const audioCallsAfterStaleStop = authedFetch.mock.calls.filter(([url]) => String(url).includes('/audio'));
    expect(audioCallsAfterStaleStop).toHaveLength(0);
  });

  it('does not start a recorder after the session already ended while requesting the microphone', async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-pending-mic' });
      return json({ ok: true });
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    const startPromise = userEvent.click(screen.getByRole('button', { name: '开始录音' }));
    await screen.findByText('实时录音');
    await vi.waitFor(() => expect(MockEventSource.instances).toHaveLength(1));

    act(() => {
      MockEventSource.instances[0].emit('message', {
        type: 'error',
        stream: 'realtime',
        id: 'sess-pending-mic',
        session_id: 'sess-pending-mic',
        error: '麦克风会话已结束',
      });
    });
    resolveStream?.({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream);
    await startPromise;

    expect(MockMediaRecorder.instances).toHaveLength(0);
    await vi.waitFor(() => expect(authedFetch.mock.calls.some(([url, opts]) => (
      url === '/asr/realtime/sess-pending-mic'
      && opts?.method === 'DELETE'
    ))).toBe(true));
  });
});
