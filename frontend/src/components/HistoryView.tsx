import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, FolderClosed, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { HistoryTask } from '../types';
import { errorMessage, responseError } from '../lib/errors';

interface HistoryViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onLoadTask: (taskId: string) => void;
  /** Navigate to the upload view — used by the empty state. */
  onGoToTasks?: () => void;
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
}) => {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [page, setPage] = useState(0);

  const loadHistory = async (nextPage = page) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      limit: String(PAGE),
      offset: String(nextPage * PAGE),
    });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    const sinceSec = dayStart(since);
    const untilSec = dayEnd(until);
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

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadHistory(0); }, []);

  const applyFilters = () => {
    setPage(0);
    void loadHistory(0);
  };

  const removeTask = async (taskId: string) => {
    if (!confirm('确认从历史中删除这条记录？')) return;
    try {
      const r = await authedFetch(`/asr/task/${taskId}`, { method: 'DELETE' });
      if (!r.ok) throw await responseError(r);
      const nextPage = tasks.length === 1 && page > 0 ? page - 1 : page;
      setPage(nextPage);
      await loadHistory(nextPage);
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
      <div className="card p-6">
        <h3 className="section-title justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <span>历史转写记录</span>
            <span className="text-sm font-normal text-muted">{totalCount} 个任务</span>
          </div>

          <button
            onClick={() => void loadHistory()}
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
              onClick={() => {
                setQ(''); setStatus(''); setSince(''); setUntil('');
                setPage(0);
                void loadHistory(0);
              }}
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
                : '在「文件转写」上传音频后，任务会自动归档到这里'}
            </p>
            <button
              onClick={() => {
                if (q || status || since || until) {
                  setQ(''); setStatus(''); setSince(''); setUntil('');
                  setPage(0);
                  void loadHistory(0);
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
              const title = t.original_name || t.text || '（暂无文本预览）';
              return (
                <motion.div
                  key={t.task_id}
                  className="hist-item group"
                >
                  <button
                    type="button"
                    className="!block min-w-0 !rounded-none !border-0 !bg-transparent !px-0 !py-0 !pr-4 !text-left !font-normal !select-text hover:!border-transparent hover:!bg-transparent"
                    aria-label={`打开任务：${title}`}
                    onClick={() => onLoadTask(t.task_id)}
                  >
                    <div className="text-fg font-semibold text-[13.5px] truncate max-w-2xl leading-normal">
                      {title}
                    </div>
                    {t.original_name && t.text && (
                      <div className="text-[12px] text-muted truncate max-w-2xl mt-0.5">{t.text}</div>
                    )}
                    <div className="tid font-mono text-meta text-muted-2 mt-1">
                      #{t.task_id} · {formatWhen(t.created_at)}
                    </div>
                  </button>

                  <div className="flex items-center shrink-0 justify-end">
                    <span className={`badge ${statusClass(t.status)}`}>
                      <span className="dot" />
                      <span>{STATUS_LABEL[t.status] || t.status}</span>
                    </span>
                  </div>

                  <div className="shrink-0 text-right text-sm text-muted tabular-nums">
                    {t.finished_segments || 0}/{t.total_segments || 0} 片
                  </div>

                  <div className="shrink-0 text-right text-sm text-muted tabular-nums">
                    {formatDur(t.duration || 0)}
                  </div>

                  <button
                    className="danger p-1.5"
                    aria-label={`删除任务：${title}`}
                    onClick={() => void removeTask(t.task_id)}
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
              onClick={() => {
                const next = page - 1;
                setPage(next);
                void loadHistory(next);
              }}
            >
              上一页
            </button>
            <span className="tabular-nums">{page + 1} / {pages}</span>
            <button
              disabled={page + 1 >= pages || loading}
              onClick={() => {
                const next = page + 1;
                setPage(next);
                void loadHistory(next);
              }}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
