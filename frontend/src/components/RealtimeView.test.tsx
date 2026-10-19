import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../lib/download';
import { RealtimeView } from './RealtimeView';
import {
  MockEventSource,
  MockMediaRecorder,
  installRealtimeMocks,
  json,
  stubClipboard,
  textDeltaEvent,
} from '../test/realtimeMocks';

vi.mock('../lib/download', () => ({ downloadFile: vi.fn() }));

/**
 * Recorder-only suite. The manual-session / file-simulator / event-console
 * tests now live in RealtimeApiDebugView.test.tsx — after the product/debug
 * split they are a different component with a different mount.
 */
describe('<RealtimeView /> browser recorder', () => {
  beforeEach(() => installRealtimeMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('starts browser recording and shows realtime text on the white board', async () => {
    const clipboardWriteText = stubClipboard();
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-1' });
      if (url === '/asr/realtime/sess-1') return json({ bytes_received: 128 });
      if (url === '/asr/realtime/sess-1/audio') return json({ ok: true });
      return json({});
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);

    expect(screen.getByRole('button', { name: '复制文稿' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下载 TXT' })).toBeDisabled();

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
      MockEventSource.instances[0].emit('message', textDeltaEvent('sess-1', 0, '你好，正在识别。'));
    });
    expect(await screen.findByText('你好，正在识别。')).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0].emit('message', textDeltaEvent('sess-1', 1, '😃', 2));
    });
    expect(await screen.findByText('你😃正在识别。')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '复制文稿' }));
    expect(clipboardWriteText).toHaveBeenCalledWith('你😃正在识别。');
    expect(await screen.findByRole('status')).toHaveTextContent('文稿已复制到剪贴板');

    clipboardWriteText.mockRejectedValueOnce(new Error('permission denied'));
    await userEvent.click(screen.getByRole('button', { name: '复制文稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法访问剪贴板，文稿仍保留在屏幕上');
    expect(screen.getByText('你😃正在识别。')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下载 TXT' }));
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
