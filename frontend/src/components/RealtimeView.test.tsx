import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../lib/download';
import { RealtimeView } from './RealtimeView';
import {
  MockAudioContext,
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
    // Dated, so two recordings do not overwrite each other in Downloads.
    expect(downloadFile).toHaveBeenCalledWith(
      expect.stringMatching(/^realtime-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/),
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

    await userEvent.click(screen.getByRole('button', { name: /调试日志/ }));
    await userEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(clipboardWriteText).toHaveBeenLastCalledWith(expect.stringContaining('session_created'));
    expect(await screen.findByText('调试日志已复制到剪贴板')).toHaveAttribute('role', 'status');

    clipboardWriteText.mockRejectedValueOnce(new Error('permission denied'));
    await userEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(await screen.findByText('无法访问剪贴板，请手动选择下方日志复制')).toHaveAttribute('role', 'alert');
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

  it('says so when the microphone has been silent for a few seconds', async () => {
    // A muted microphone encodes a perfectly good recording of nothing. The
    // only moment that is still fixable is while it is happening.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const authedFetch = vi.fn(async (url: string) => {
        if (url === '/asr/realtime/session') return json({ session_id: 'sess-silent' });
        return json({ ok: true });
      });
      render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
      await userEvent.click(screen.getByRole('button', { name: '开始录音' }));
      expect(screen.getByText('录音中')).toBeInTheDocument();
      // Nothing ever raises a bin above the noise floor.
      MockAudioContext.instances.forEach((ctx) => { ctx.level = 0; });

      act(() => { vi.advanceTimersByTime(5000); });

      expect(await screen.findByText(/没有收到声音/)).toBeInTheDocument();
      expect(screen.getByText('等待声音')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the recording on Escape, but not from inside a text field', async () => {
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-esc' });
      return json({ ok: true });
    });
    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));
    expect(screen.getByText('录音中')).toBeInTheDocument();

    // Escape aimed at a field is that field's business, not the recorder's.
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('录音中')).toBeInTheDocument();
    field.remove();

    // Escape on the page stops the recording and moves it to the final pass.
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByText('识别中')).toBeInTheDocument();
  });

  it('explains a denied microphone permission instead of echoing the DOMException', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        }),
      },
    });
    let sessionActive = false;
    const authedFetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/asr/realtime/session') {
        sessionActive = true;
        return json({ session_id: 'sess-denied' });
      }
      if (url === '/asr/realtime/sessions') {
        return json({ sessions: sessionActive ? [{ status: 'active' }] : [] });
      }
      if (url === '/asr/realtime/sess-denied' && options?.method === 'DELETE') {
        sessionActive = false;
        return json({ ok: true });
      }
      return json({ ok: true });
    });

    const view = render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    // The app starts before its config request fills maxSessions. Changing the
    // prop re-runs the capacity effect and must not leave mountedRef stuck false.
    view.rerender(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} maxSessions={4} />);
    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));

    // "Permission denied" alone does not tell anyone where to click.
    expect(await screen.findByText(/麦克风权限被拒绝/)).toBeInTheDocument();
    expect(screen.getByText('发生错误')).toBeInTheDocument();
    expect(await screen.findByText('在用 0/4 路')).toBeInTheDocument();
    expect(authedFetch).toHaveBeenCalledWith('/asr/realtime/sess-denied', { method: 'DELETE' });
  });

  it('explains a machine with no audio input instead of saying "Not supported"', async () => {
    // Chrome reports a missing capture device as the two-word DOMException
    // message \"Not supported\" — on a remote desktop or a VM with no sound
    // hardware that string is what a user would be left staring at.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw Object.assign(new Error('Not supported'), { name: 'NotSupportedError' });
        }),
      },
    });
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-noaudio' });
      return json({ ok: true });
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);
    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));

    expect(await screen.findByText(/无法开启录音/)).toBeInTheDocument();
    expect(screen.getByText(/输入设备/)).toBeInTheDocument();
    expect(screen.queryByText('Not supported')).not.toBeInTheDocument();
    expect(screen.getByText('发生错误')).toBeInTheDocument();
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
  it('exports SRT and VTT cut at the upstream sentence boundaries it was told about', async () => {
    // The server archives a realtime session with no segments, so the subtitle
    // timeline is built here from upstream `final` frames plus this client's
    // session clock. Both halves of that claim have to be visible in the output.
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-srt' });
      return json({ ok: true });
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} realtimeProvider="realtime_ws" />);
    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));

    expect(screen.getByRole('button', { name: '下载 SRT' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下载 VTT' })).toBeDisabled();

    act(() => {
      // Online frames stream the sentence in progress; a `final` frame is the
      // one where upstream says the sentence is settled, and that instant is
      // the only cut the tracker makes.
      const es = MockEventSource.instances[0];
      es.emit('message', textDeltaEvent('sess-srt', 0, '第一句', 0, 200, false));
      es.emit('message', textDeltaEvent('sess-srt', 3, '话', 0, 800, true));
      es.emit('message', textDeltaEvent('sess-srt', 4, '第二句', 0, 900, false));
      es.emit('message', textDeltaEvent('sess-srt', 7, '话', 0, 2_400, true));
      // Text with no boundary after it: its cue has to run to "now".
      es.emit('message', textDeltaEvent('sess-srt', 8, '还没说完的第三句', 0, 2_600, false));
    });
    expect(await screen.findByText('第一句话第二句话还没说完的第三句')).toBeInTheDocument();

    // The caveat is readable text, not a hover tooltip nobody will find.
    expect(await screen.findByText(/字幕时间按本次录音的墙钟计时，2 个切点/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下载 SRT' }));
    const [srtName, srtBody, srtType] = downloadFile.mock.calls.at(-1) as [string, string, string];
    expect(srtName).toMatch(/^realtime-\d{4}-\d{2}-\d{2}-\d{4}\.srt$/);
    expect(srtType).toBe('text/plain;charset=utf-8');
    // Both settled sentences are timed by the measured boundary instants; only
    // the third cue's end is the wall clock, so it is the one left unpinned.
    expect(srtBody).toContain('1\n00:00:00,000 --> 00:00:00,800\n第一句话\n');
    expect(srtBody).toContain('2\n00:00:00,800 --> 00:00:02,400\n第二句话\n');
    expect(srtBody).toContain('3\n00:00:02,400 --> ');
    expect(srtBody).toContain('还没说完的第三句');

    await userEvent.click(screen.getByRole('button', { name: '下载 VTT' }));
    const [vttName, vttBody] = downloadFile.mock.calls.at(-1) as [string, string];
    expect(vttName).toMatch(/\.vtt$/);
    expect(vttBody).toContain('WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.800\n第一句话\n');
    expect(vttBody).toContain('2\n00:00:00.800 --> 00:00:02.400\n第二句话\n');
  });

  it('names a provider whose text does not arrive while recording, and links to the setting', async () => {
    const onOpenConfig = vi.fn();
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-mock' });
      return json({ ok: true });
    });

    render(
      <RealtimeView
        authedFetch={authedFetch}
        sseUrl={(path) => path}
        realtimeProvider="realtime_mock"
        onOpenConfig={onOpenConfig}
      />,
    );

    // The first-run guide disappears after the first config edit; this one has
    // to stay as long as the setting is still the surprising one.
    expect(await screen.findByText(/当前是演示 provider/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '去服务配置' }));
    expect(onOpenConfig).toHaveBeenCalled();

    const streaming = render(
      <RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} realtimeProvider="realtime_ws" />,
    );
    expect(streaming.container.textContent).not.toContain('演示 provider');
  });
});
