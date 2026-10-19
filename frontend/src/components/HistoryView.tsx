import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, FolderClosed, Mic, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { HistoryTask } from '../types';
import { errorMessage, responseError } from '../lib/errors';
import { useConfirmDialog } from './ConfirmDialog';
import { HistoryTranscriptDialog } from './HistoryTranscriptDialog';

/**
 * The filters and page that are currently in force. App owns them when the
 * console is hash-routed so a link like #/history?status=failed&page=2 opens
 * the same list it says; the props are optional so the view still works as a
 * standalone component (and in tests) with its own state.
 */
export interface HistoryFilters {
  q: string;
  status: string;
  since: string;
  until: string;
  page: number;
}

interface HistoryViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onLoadTask: (taskId: string) => void;
  /** Navigate to the upload view — used by the empty state. */
  onGoToTasks?: () => void;
  filters?: HistoryFilters;
  onFiltersChange?: (next: HistoryFilters) => void;
}

const PAGE = 20;

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  processing: '识别中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const statusClass = (status: string) => {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'cancelled') return '';
  return 'warn';
};

const dayStart = (value: string) => {
  if (!value) return '';
  const ms = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ms) ? '' : String(Math.floor(ms / 1000));
};

const dayEnd = (value: string) => {
  if (!value) return '';
  const ms = new Date(`${value}T23:59:59`).getTime();
  return Number.isNaN(ms) ? '' : String(Math.floor(ms / 1000));
};

export const HistoryView: React.FC<HistoryViewProps> = ({
  authedFetch,
  onLoadTask,
  onGoToTasks,
  filters: filtersProp,
  onFiltersChange,
}) => {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Draft filter values. They start from whatever the URL carried and only
  // become a request on 筛选 / Enter — typing in a search box should not fire
  // a history query per keystroke.
  const [q, setQ] = useState(filtersProp?.q ?? '');
  const [status, setStatus] = useState(filtersProp?.status ?? '');
  const [since, setSince] = useState(filtersProp?.since ?? '');
  const [until, setUntil] = useState(filtersProp?.until ?? '');
  const [page, setPage] = useState(filtersProp?.page ?? 0);
  // Archived realtime recordings have no media file to open, so they are read
  // here instead of being loaded into the 文件转写 workspace.
  const [reading, setReading] = useState<HistoryTask | null>(null);
  const { confirm: confirmDialog, dialog: confirmElement } = useConfirmDialog();

  const loadHistory = async (next: HistoryFilters) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      limit: String(PAGE),
      offset: String(next.page * PAGE),
    });
    if (next.q.trim()) params.set('q', next.q.trim());
    if (next.status) params.set('status', next.status);
    const sinceSec = dayStart(next.since);
    const untilSec = dayEnd(next.until);
    if (sinceSec) params.set('since', sinceSec);
    if (untilSec) params.set('until', untilSec);
    try {
      const r = await authedFetch(`/asr/tasks?${params}`);
      if (!r.ok) throw await responseError(r);
      const data = await r.json();
      setTasks(data.tasks || []);
      setTotalCount(data.total || 0);
    } catch (e) {
      setError(`拉取历史归档失败: ${errorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const draft = (): HistoryFilters => ({ q, status, since, until, page });

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadHistory(draft()); }, []);

  /**
   * Publish a filter/page change: the request uses the values passed in (not
   * whatever the inputs held when the response arrived), and the same object
   * goes to the URL so the address bar and the list never disagree.
   */
  const commit = (next: HistoryFilters) => {
    setQ(next.q);
    setStatus(next.status);
    setSince(next.since);
    setUntil(next.until);
    setPage(next.page);
    onFiltersChange?.(next);
    void loadHistory(next);
  };

  const applyFilters = () => commit({ q, status, since, until, page: 0 });

  const clearFilters = () => commit({ q: '', status: '', since: '', until: '', page: 0 });

  const removeTask = async (task: HistoryTask) => {
    const ok = await confirmDialog({
      title: '删除这条历史记录？',
      message: (
        <>
          删除后这条记录及其识别结果、分片和生成的字幕文件都会从服务端移除，无法恢复。
          本机浏览器里如果还留着这段任务的缓存视图，关闭后也不再能重新打开。
        </>
      ),
      confirmLabel: '删除记录',
    });
    if (!ok) return;
    try {
      const r = await authedFetch(`/asr/task/${task.task_id}`, { method: 'DELETE' });
      if (!r.ok) throw await responseError(r);
      const nextPage = tasks.length === 1 && page > 0 ? page - 1 : page;
      commit({ q, status, since, until, page: nextPage });
    } catch (e) {
      setError(`删除失败: ${errorMessage(e)}`);
    }
  };

  const formatWhen = (ts?: number) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  };

  const formatDur = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}h${m}m` : `${m}m${sec}s`;
  };

  const pages = Math.max(1, Math.ceil(totalCount / PAGE));

  return (
    <div className="flex flex-col gap-6">
      {confirmElement}
      {reading && (
        <HistoryTranscriptDialog task={reading} authedFetch={authedFetch} onClose={() => setReading(null)} />
      )}

      <div className="card p-6">
        <h3 className="section-title justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <span>历史转写记录</span>
            <span className="text-sm font-normal text-muted">{totalCount} 个任务</span>
          </div>

          <button
            onClick={() => void loadHistory(draft())}
            disabled={loading}
            className="text-[12px] px-3.5 py-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end mb-4">
          <label className="field lg:col-span-2">
            <span>搜索</span>
            <input
              type="search"
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyFilters(); }}
              placeholder="文件名、任务号、转写文本"
            />
          </label>
          <label className="field">
            <span>状态</span>
            <select value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">全部</option>
              <option value="queued">排队中</option>
              <option value="processing">识别中</option>
              <option value="done">已完成</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
          </label>
          <label className="field">
            <span>开始</span>
            <input type="date" value={since} onChange={e => setSince(e.target.value)} />
          </label>
          <label className="field">
            <span>结束</span>
            <input type="date" value={until} onChange={e => setUntil(e.target.value)} />
          </label>
        </div>
        <div className="flex items-center gap-2 mb-5">
          <button onClick={applyFilters} className="primary text-[12px] px-3.5 py-1.5">
            <Search className="w-3.5 h-3.5" />
            <span>筛选</span>
          </button>
          {(q || status || since || until) && (
            <button
              onClick={clearFilters}
              className="text-[12px] px-3.5 py-1.5"
            >
              <X className="w-3.5 h-3.5" />
              <span>重置</span>
            </button>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-[10px] border border-err/30 bg-err-soft px-4 py-3 text-err text-sm mb-4">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <div className="text-muted text-sm text-center py-20">正在读取历史记录…</div>
        ) : tasks.length === 0 ? (
          <div className="hist-empty py-16">
            <FolderClosed className="w-9 h-9 mx-auto opacity-20 text-muted mb-3" />
            <p className="text-fg-dim">
              {q || status || since || until ? '没有符合条件的转写任务' : '还没有转写记录'}
            </p>
            <p className="text-meta text-muted-2 mt-1">
              {q || status || since || until
                ? '换个条件，或清空筛选看看全部记录'
                : '「文件转写」的任务和「实时识别」的录音结束后都会自动归档到这里，保留 7 天'}
            </p>
            <button
              onClick={() => {
                if (q || status || since || until) {
                  clearFilters();
                } else {
                  onGoToTasks?.();
                }
              }}
              className="mt-4 text-[12px] px-3.5 py-1.5"
            >
              {q || status || since || until ? '清空筛选' : '去文件转写'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tasks.map((t) => {
              const isRealtime = t.kind === 'realtime';
              const title = t.original_name || t.text || '（暂无文本预览）';
              // A restart is not an upstream ASR failure. The backend stores it as
              // status=failed with error_code="interrupted" (it refuses any other
              // status value), so the only way to tell the two apart is the code.
              const interrupted = t.error_code === 'interrupted';
              const failure = [t.error, t.hint].filter(Boolean).join(' · ');
              return (
                <motion.div
                  key={t.task_id}
                  className="hist-item group"
                >
                  <button
                    type="button"
                    className="!block min-w-0 !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pr-4 !text-left !font-normal !select-text hover:!border-transparent hover:!bg-transparent"
                    aria-label={isRealtime ? `查看录音：${title}` : `打开任务：${title}`}
                    onClick={() => { if (isRealtime) setReading(t); else onLoadTask(t.task_id); }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isRealtime && <Mic className="w-3.5 h-3.5 shrink-0 text-muted" aria-hidden="true" />}
                      <span className="text-fg font-semibold text-[13.5px] truncate max-w-2xl leading-normal">
                        {title}
                      </span>
                    </div>
                    {t.original_name && t.text && (
                      <div className="text-[12px] text-muted truncate max-w-2xl mt-0.5">{t.text}</div>
                    )}
                    {/* The reason a row failed belongs to the row itself: hiding
                        it behind the status badge means the user has to open the
                        task to learn there is nothing to open. */}
                    {t.status === 'failed' && failure && (
                      <div className="mt-1 flex items-start gap-2 text-[12px] text-err">
                        {interrupted && (
                          <span className="badge err shrink-0">
                            <span className="dot" />
                            <span>服务中断</span>
                          </span>
                        )}
                        <span className="line-clamp-2 max-w-2xl">{failure}</span>
                      </div>
                    )}
                    <div className="tid font-mono text-meta text-muted-2 mt-1">
                      #{t.task_id} · {formatWhen(t.created_at)}
                    </div>
                  </button>

                  <div className="flex items-center shrink-0 justify-end">
                    <span className={`badge ${statusClass(t.status)}`} title={t.status === 'failed' ? t.error || undefined : undefined}>
                      <span className="dot" />
                      <span>{STATUS_LABEL[t.status] || t.status}</span>
                    </span>
                  </div>

                  <div className="shrink-0 text-right text-sm text-muted tabular-nums">
                    {/* A realtime archive has no segments by construction, so
                        "0/0 片" would read as a pipeline that produced nothing. */}
                    {isRealtime ? '整段' : `${t.finished_segments || 0}/${t.total_segments || 0} 片`}
                  </div>

                  <div className="shrink-0 text-right text-sm text-muted tabular-nums">
                    {formatDur(t.duration || 0)}
                  </div>

                  <button
                    className="danger p-1.5"
                    aria-label={`删除任务：${title}`}
                    onClick={() => void removeTask(t)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </motion.div>
              );
            })}
          </div>
        )}

        {totalCount > PAGE && (
          <div className="flex items-center justify-end gap-3 mt-5 text-sm text-muted">
            <button
              disabled={page === 0 || loading}
              onClick={() => commit({ q, status, since, until, page: page - 1 })}
            >
              上一页
            </button>
            <span className="tabular-nums">{page + 1} / {pages}</span>
            <button
              disabled={page + 1 >= pages || loading}
              onClick={() => commit({ q, status, since, until, page: page + 1 })}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
