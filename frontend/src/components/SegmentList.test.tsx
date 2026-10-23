import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SegmentList } from './SegmentList';
import { ASRSegment } from '../types';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const seg = (over: Partial<ASRSegment> = {}): ASRSegment => ({
  segment_id: 1,
  start: 0,
  end: 12.5,
  text: '第一段识别文本',
  is_final: true,
  elapsed_ms: 1200,
  ...over,
});

const noop = vi.fn(async () => json({}));

describe('<SegmentList />', () => {
  it('renders each segment on one row with its own timestamp', () => {
    render(
      <SegmentList
        segments={[seg(), seg({ segment_id: 2, start: 12.5, end: 30, text: '第二段识别文本' })]}
        taskId="t1"
        authedFetch={noop}
      />,
    );

    expect(screen.getByText('第一段识别文本')).toBeInTheDocument();
    expect(screen.getByText('第二段识别文本')).toBeInTheDocument();
    expect(screen.getByText('00:00.0 – 00:12.5')).toBeInTheDocument();
    expect(screen.getAllByText('1')).toHaveLength(1);
  });

  it('shows the whole transcript — no truncation class on segment text', () => {
    const long = '这是一段很长的识别文本'.repeat(20);
    render(<SegmentList segments={[seg({ text: long })]} taskId="t1" authedFetch={noop} />);

    const p = screen.getByText(long);
    expect(p.className).not.toMatch(/truncate/);
    expect(p.className).toMatch(/break-words/);
  });

  it('seeks to a segment start without toggling the raw panel', async () => {
    const onSeek = vi.fn();
    const fetchMock = vi.fn(async () => json({ detail: 'x' }));
    render(
      <SegmentList segments={[seg()]} taskId="t1" authedFetch={fetchMock} onSeek={onSeek} />,
    );

    await userEvent.click(screen.getByRole('button', { name: '播放第 1 段' }));

    expect(onSeek).toHaveBeenCalledWith(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an edited segment text on commit', async () => {
    const onEditText = vi.fn();
    render(
      <SegmentList segments={[seg()]} taskId="t1" authedFetch={noop} onEditText={onEditText} />,
    );

    await userEvent.dblClick(screen.getByText('第一段识别文本'));
    const box = screen.getByRole('textbox');
    await userEvent.clear(box);
    await userEvent.type(box, '校对后的文本');
    await userEvent.keyboard('{Enter}');

    expect(onEditText).toHaveBeenCalledWith(1, '校对后的文本');
  });

  it('cancels an edit with Escape instead of committing the draft on blur', async () => {
    const onEditText = vi.fn();
    render(
      <SegmentList segments={[seg()]} taskId="t1" authedFetch={noop} onEditText={onEditText} />,
    );

    await userEvent.dblClick(screen.getByText('第一段识别文本'));
    const box = screen.getByRole('textbox');
    await userEvent.clear(box);
    await userEvent.type(box, '不应保存的草稿');
    await userEvent.keyboard('{Escape}');

    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('第一段识别文本')).toBeInTheDocument();
  });

  it('does not open the editor for a failed segment', async () => {
    const onEditText = vi.fn();
    render(
      <SegmentList
        segments={[seg({ error: 'upstream 502', is_final: false })]}
        taskId="t1"
        authedFetch={noop}
        onEditText={onEditText}
      />,
    );

    const body = screen.getByText('upstream 502');
    await userEvent.dblClick(body);

    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows a failure state when the browser refuses to copy raw data', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
    });
    const fetchMock = vi.fn(async () => json({ text: 'raw' }));
    render(<SegmentList segments={[seg()]} taskId="t1" authedFetch={fetchMock} />);

    await userEvent.click(screen.getByRole('button', { expanded: false }));
    await screen.findByText('上游原始返回');
    await userEvent.click(screen.getByRole('button', { name: '复制' }));

    expect(await screen.findByText('复制失败，请检查浏览器权限')).toBeInTheDocument();
    expect(screen.queryByText('已复制')).not.toBeInTheDocument();
  });

  it('loads the raw upstream payload only when the row is expanded', async () => {
    const fetchMock = vi.fn(async () => json({ text: 'raw' }));
    render(<SegmentList segments={[seg()]} taskId="t1" authedFetch={fetchMock} />);

    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/asr/task/t1/segments/1/raw'),
    );
    expect(await screen.findByText('上游原始返回')).toBeInTheDocument();
  });
  it('searches the list instead of making the operator scroll it', async () => {
    const segments = [
      seg(),
      seg({ segment_id: 2, start: 30, end: 44, text: '会议纪要第二部分' }),
      seg({ segment_id: 3, start: 44, end: 60, text: '第三段识别文本' }),
      seg({ segment_id: 4, start: 60, end: 75, text: '', error: '分片 4 识别失败' }),
    ];
    render(<SegmentList segments={segments} taskId="t1" authedFetch={noop} />);

    // A list this long is where search earns its place.
    await userEvent.type(screen.getByRole('searchbox'), '会议');
    expect(screen.getByText('会议纪要第二部分')).toBeInTheDocument();
    expect(screen.queryByText('第一段识别文本')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 / 4 段');

    // Segment numbers are what the raw error messages quote, so they search too.
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), '4');
    expect(screen.getByText('分片 4 识别失败')).toBeInTheDocument();
    expect(screen.queryByText('会议纪要第二部分')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox'));
    expect(await screen.findByText('第一段识别文本')).toBeInTheDocument();
  });

  it('filters to the failed segments and offers a way out of an empty result', async () => {
    const segments = [
      seg(),
      seg({ segment_id: 2, text: '第二段识别文本' }),
      seg({ segment_id: 3, text: '第三段识别文本' }),
      seg({ segment_id: 4, text: '', error: '分片 4 识别失败' }),
    ];
    render(<SegmentList segments={segments} taskId="t1" authedFetch={noop} />);

    const onlyFailed = await screen.findByRole('button', { name: /只看失败（1）/ });
    expect(onlyFailed).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(onlyFailed);
    expect(onlyFailed).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('分片 4 识别失败')).toBeInTheDocument();
    expect(screen.queryByText('第一段识别文本')).not.toBeInTheDocument();

    // A query nobody can clear is a list that looks empty.
    await userEvent.type(screen.getByRole('searchbox'), '不存在的词');
    expect(await screen.findByText('没有分片包含「不存在的词」')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看全部分片' }));
    expect(onlyFailed).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByText('第一段识别文本')).toBeInTheDocument();
  });
});
