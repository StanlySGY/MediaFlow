import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

  it('deletes a task without opening it', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { authedFetch, onLoadTask } = renderHistory();
    const deleteButton = await screen.findByRole('button', { name: '删除任务：lecture.wav' });

    await user.click(deleteButton);

    await waitFor(() => {
      expect(authedFetch).toHaveBeenCalledWith('/asr/task/task-1', { method: 'DELETE' });
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(onLoadTask).not.toHaveBeenCalled();
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
