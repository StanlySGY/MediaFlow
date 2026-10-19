import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../lib/download';
import { RealtimeApiDebugView } from './RealtimeApiDebugView';
import {
  MockEventSource,
  installRealtimeMocks,
  json,
  stubClipboard,
  textDeltaEvent,
} from '../test/realtimeMocks';

vi.mock('../lib/download', () => ({ downloadFile: vi.fn() }));

const ACCORDION = '接口会话 · 手动建会话、文件模拟、事件流';

/**
 * The debug view mounts no microphone: it exists to drive the HTTP/SSE
 * interface by hand, so the suite installs EventSource only.
 */
const renderDebug = () => render(<RealtimeApiDebugView authedFetch={authedFetchFor()} sseUrl={(path) => path} />);

let sessionCounter = 0;
const authedFetchFor = () =>
  vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') return json({ ok: true });
    if (url === '/asr/realtime/session') {
      sessionCounter += 1;
      return json({ session_id: `manual-${sessionCounter}` });
    }
    return json({ ok: true });
  });

describe('<RealtimeApiDebugView /> manual sessions', () => {
  beforeEach(() => {
    sessionCounter = 0;
    installRealtimeMocks({ media: false });
    vi.mocked(downloadFile).mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('copies and downloads the reconstructed session transcript, not event deltas', async () => {
    const clipboardWriteText = stubClipboard();
    renderDebug();

    await userEvent.click(screen.getByRole('button', { name: ACCORDION }));
    await userEvent.click(screen.getByRole('button', { name: '创建会话' }));

    const copyButton = await screen.findByRole('button', { name: '复制会话文稿' });
    expect(copyButton).toBeDisabled();
    expect(screen.getByRole('button', { name: '下载会话 TXT' })).toBeDisabled();

    act(() => {
      MockEventSource.instances[0].emit('message', textDeltaEvent('manual-1', 0, '模拟转写旧稿'));
      MockEventSource.instances[0].emit('message', textDeltaEvent('manual-1', 4, '新稿', 2));
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

  it('keeps a session active and replaces replayed event rows after reconnect', async () => {
    const deleteRequests: string[] = [];
    const authedFetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') deleteRequests.push(url);
      if (url === '/asr/realtime/session') return json({ session_id: 'manual-reconnect' });
      return json({ ok: true });
    });

    const { container } = render(
      <RealtimeApiDebugView authedFetch={authedFetch} sseUrl={(path) => path} />
    );
    await userEvent.click(screen.getByRole('button', { name: ACCORDION }));
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
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('事件流连接中断，正在重新连接');
    expect(source.closeCalls).toBe(0);
    expect(deleteRequests).toEqual([]);

    // Reconnect replays from an empty baseline, so the old rows are replaced
    // rather than appended to — and the session itself is not torn down.
    act(() => source.emitOpen());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => {
      source.emit('message', textDeltaEvent('manual-reconnect', 0, '你好'));
      source.emit('message', textDeltaEvent('manual-reconnect', 2, '世界'));
    });

    expect(await screen.findByText('2 条')).toBeInTheDocument();
    expect(container.querySelectorAll('.ev')).toHaveLength(2);
    expect(screen.getAllByText('你好世界')).toHaveLength(1);
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(source.closeCalls).toBe(0);
    expect(deleteRequests).toEqual([]);
  });

  it('asks before deleting a session, and only sends DELETE on confirm', async () => {
    const deleteRequests: string[] = [];
    const authedFetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        deleteRequests.push(url);
        return json({ ok: true });
      }
      if (url === '/asr/realtime/session') return json({ session_id: 'manual-close' });
      return json({ ok: true });
    });

    render(<RealtimeApiDebugView authedFetch={authedFetch} sseUrl={(path) => path} />);
    await userEvent.click(screen.getByRole('button', { name: ACCORDION }));
    await userEvent.click(screen.getByRole('button', { name: '创建会话' }));
    await screen.findByText('进行中');

    await userEvent.click(screen.getByRole('button', { name: '关闭当前会话' }));

    // Mounted outside the accordion, so the question is visible even when the
    // panel it was asked from is collapsed.
    const dialog = await screen.findByRole('dialog', { name: '关闭并删除会话？' });
    expect(within(dialog).getByText(/未发送完的音频不会再有结果/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteRequests).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: '关闭当前会话' }));
    await userEvent.click(await screen.findByRole('button', { name: '关闭会话' }));

    await vi.waitFor(() => expect(deleteRequests).toContain('/asr/realtime/manual-close'));
    expect(MockEventSource.instances[0].closeCalls).toBeGreaterThan(0);
  });
});
