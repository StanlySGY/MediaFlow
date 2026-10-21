import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryView } from './HistoryView';

const task = {
  task_id: 'task-1',
  original_name: 'lecture.wav',
  status: 'done',
  duration: 65,
  finished_segments: 2,
  total_segments: 2,
  created_at: 1_759_363_200,
};

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
}) as Response;

const renderHistory = () => {
  const authedFetch = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') return json({});
    return json({ tasks: [task], total: 1 });
  });
  const onLoadTask = vi.fn();

  render(<HistoryView authedFetch={authedFetch} onLoadTask={onLoadTask} />);

  return { authedFetch, onLoadTask };
};

describe('<HistoryView /> item actions', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens a history task with Enter and Space', async () => {
    const user = userEvent.setup();
    const { onLoadTask } = renderHistory();
    const openButton = await screen.findByRole('button', { name: '打开任务：lecture.wav' });

    openButton.focus();
    await user.keyboard('{Enter}');
    expect(onLoadTask).toHaveBeenLastCalledWith('task-1');

    onLoadTask.mockClear();
    await user.keyboard(' ');
    expect(onLoadTask).toHaveBeenCalledExactlyOnceWith('task-1');
  });

  it('asks in the page before deleting, and only deletes on confirm', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => { throw new Error('native confirm must not be used'); }));
    const { authedFetch, onLoadTask } = renderHistory();
    const deleteButton = await screen.findByRole('button', { name: '删除任务：lecture.wav' });

    await user.click(deleteButton);

    // The dialog names what is lost, so the choice is informed rather than a
    // bare yes/no about a row the user can no longer see.
    const dialog = await screen.findByRole('dialog', { name: '删除这条历史记录？' });
    expect(within(dialog).getByText(/无法恢复/)).toBeInTheDocument();
    expect(authedFetch).not.toHaveBeenCalledWith('/asr/task/task-1', { method: 'DELETE' });

    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(authedFetch).not.toHaveBeenCalledWith('/asr/task/task-1', { method: 'DELETE' });

    await user.click(deleteButton);
    await user.click(await screen.findByRole('button', { name: '删除记录' }));

    await waitFor(() => {
      expect(authedFetch).toHaveBeenCalledWith('/asr/task/task-1', { method: 'DELETE' });
    });
    expect(onLoadTask).not.toHaveBeenCalled();
  });

  it('reads an archived realtime recording in place, not in the file workspace', async () => {
    const recording = {
      task_id: 'rt-1',
      kind: 'realtime' as const,
      original_name: '实时录音 2026-10-19 10:30 · zh-base',
      status: 'done',
      duration: 42.5,
      text: '这是一段实时录音的识别结果',
      finished_segments: 0,
      total_segments: 0,
      created_at: 1_759_363_200,
    };
    const authedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/result')) {
        return json({ task_id: 'rt-1', status: 'done', text: '完整的录音转写全文', duration: 42.5, language: 'zh' });
      }
      return json({ tasks: [recording], total: 1 });
    });
    const onLoadTask = vi.fn();
    render(<HistoryView authedFetch={authedFetch} onLoadTask={onLoadTask} />);

    const openButton = await screen.findByRole('button', { name: '查看录音：实时录音 2026-10-19 10:30 · zh-base' });
    // A segment counter of "0/0 片" reads as a pipeline that produced nothing;
    // a realtime archive has no segments by construction.
    expect(screen.queryByText('0/0 片')).not.toBeInTheDocument();

    await userEvent.click(openButton);
    expect(onLoadTask).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog', { name: '实时录音 2026-10-19 10:30 · zh-base' });
    // The row preview is truncated server-side; the reader fetches the full text.
    expect(await within(dialog).findByText('完整的录音转写全文')).toBeInTheDocument();
  });

  it('starts from the filters carried by the URL and publishes changes back', async () => {
    const user = userEvent.setup();
    const authedFetch = vi.fn(async () => json({ tasks: [task], total: 41 }));
    const onFiltersChange = vi.fn();

    render(
      <HistoryView
        authedFetch={authedFetch}
        onLoadTask={vi.fn()}
        filters={{ q: '会议', status: 'failed', since: '', until: '', page: 2 }}
        onFiltersChange={onFiltersChange}
      />
    );

    // A shared #/history?status=failed&page=2 link has to open on page 3 with
    // its filters filled in, not on a fresh page 1.
    const firstRequest = String(authedFetch.mock.calls[0][0]);
    expect(firstRequest).toContain('q=%E4%BC%9A%E8%AE%AE');
    expect(firstRequest).toContain('status=failed');
    expect(firstRequest).toContain('offset=40');
    expect(screen.getByDisplayValue('会议')).toBeInTheDocument();
    expect(screen.getByDisplayValue('失败')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('状态'), 'done');
    await user.click(screen.getByRole('button', { name: /筛选/ }));

    await waitFor(() => expect(onFiltersChange).toHaveBeenCalled());
    expect(onFiltersChange.mock.calls.at(-1)?.[0]).toEqual({
      q: '会议', status: 'done', since: '', until: '', page: 0,
    });
    expect(String(authedFetch.mock.calls.at(-1)?.[0])).toContain('offset=0');
  });

  it('keeps the latest filter results when an older history request resolves late', async () => {
    const user = userEvent.setup();
    let resolveInitial!: (response: Response) => void;
    let resolveFiltered!: (response: Response) => void;
    const initialRequest = new Promise<Response>(resolve => { resolveInitial = resolve; });
    const filteredRequest = new Promise<Response>(resolve => { resolveFiltered = resolve; });
    const authedFetch = vi.fn()
      .mockImplementationOnce(() => initialRequest)
      .mockImplementationOnce(() => filteredRequest);
    render(<HistoryView authedFetch={authedFetch} onLoadTask={vi.fn()} />);

    await user.type(screen.getByRole('searchbox'), 'latest');
    await user.click(screen.getByRole('button', { name: /筛选/ }));
    expect(authedFetch).toHaveBeenCalledTimes(2);

    resolveFiltered(json({ tasks: [{ ...task, task_id: 'new', original_name: 'latest-result.wav' }], total: 1 }));
    expect(await screen.findByRole('button', { name: '打开任务：latest-result.wav' })).toBeInTheDocument();

    resolveInitial(json({ tasks: [{ ...task, task_id: 'old', original_name: 'stale-result.wav' }], total: 1 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.queryByRole('button', { name: '打开任务：stale-result.wav' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '打开任务：latest-result.wav' })).toBeInTheDocument();
  });

  it('shows a recoverable error when history fails and retries on request', async () => {
    const user = userEvent.setup();
    const failed = { ok: false, status: 503, text: async () => 'temporarily unavailable' } as Response;
    const authedFetch = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(json({ tasks: [task], total: 1 }));

    render(<HistoryView authedFetch={authedFetch} onLoadTask={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('拉取历史归档失败');
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: '打开任务：lecture.wav' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(authedFetch).toHaveBeenCalledTimes(2);
  });

  it('gives open and delete buttons task-specific accessible names as siblings', async () => {
    renderHistory();

    const openButton = await screen.findByRole('button', { name: '打开任务：lecture.wav' });
    const deleteButton = screen.getByRole('button', { name: '删除任务：lecture.wav' });

    expect(openButton).toHaveAccessibleName('打开任务：lecture.wav');
    expect(deleteButton).toHaveAccessibleName('删除任务：lecture.wav');
    expect(openButton.parentElement).toBe(deleteButton.parentElement);
    expect(openButton).not.toContainElement(deleteButton);
  });
});
