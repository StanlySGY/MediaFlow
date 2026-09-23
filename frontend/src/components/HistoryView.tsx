import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Clock, RefreshCw, FolderClosed, Layers, Trash2 } from 'lucide-react';
import { HistoryTask } from '../types';
import { errorMessage, responseError } from '../lib/errors';

interface HistoryViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onLoadTask: (taskId: string) => void;
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
          <div className="flex items-center gap-2">
            <FolderClosed className="w-5 h-5 text-accent" />
            <span>历史转写记录</span>
            <span className="badge text-xs">{totalCount} 个任务</span>
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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          <label className="field lg:col-span-2">
            <span>搜索文件名或文本</span>
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
            <span>开始日期</span>
            <input type="date" value={since} onChange={e => setSince(e.target.value)} />
          </label>
          <label className="field">
            <span>结束日期</span>
            <input type="date" value={until} onChange={e => setUntil(e.target.value)} />
          </label>
        </div>
        <div className="mb-4">
          <button onClick={applyFilters} className="primary text-[12px] px-3.5 py-1.5">筛选</button>
        </div>

        {error && (
          <div className="p-4 rounded-lg border border-err/20 bg-err-soft text-err text-xs font-mono mb-4">
            {error}
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <div className="text-muted font-mono text-xs text-center py-20 animate-pulse">
            正在读取历史记录…
          </div>
        ) : tasks.length === 0 ? (
          <div className="hist-empty py-16">
            <FolderClosed className="w-10 h-10 mx-auto opacity-25 text-muted mb-3" />
            <p>没有符合条件的转写任务</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tasks.map((t) => {
              const title = t.original_name || t.text || '（暂无文本预览）';
              return (
                <motion.div
                  key={t.task_id}
                  onClick={() => onLoadTask(t.task_id)}
                  whileHover={{ y: -2 }}
                  className="hist-item group"
                >
                  <div className="min-w-0 pr-4">
                    <div className="text-fg font-semibold text-[13.5px] truncate max-w-2xl leading-normal">
                      {title}
                    </div>
                    {t.original_name && t.text && (
                      <div className="text-[12px] text-muted truncate max-w-2xl mt-0.5">{t.text}</div>
                    )}
                    <div className="tid font-mono text-[10px] text-muted mt-1">
                      #{t.task_id} · {formatWhen(t.created_at)}
                    </div>
                  </div>

                  <div className="flex items-center shrink-0 justify-end">
                    <span className={`badge ${statusClass(t.status)}`}>
                      <span className="dot" />
                      <span>{STATUS_LABEL[t.status] || t.status}</span>
                    </span>
                  </div>

                  <div className="flex items-center shrink-0 justify-end text-[11px] font-mono text-fg-dim gap-1">
                    <Layers className="w-3.5 h-3.5 text-accent" />
                    <span>{t.finished_segments || 0}/{t.total_segments || 0} 片</span>
                  </div>

                  <div className="flex items-center shrink-0 justify-end text-[11px] font-mono text-fg-dim gap-1">
                    <Clock className="w-3.5 h-3.5 text-accent-2" />
                    <span>{formatDur(t.duration || 0)}</span>
                  </div>

                  <button
                    className="danger p-1.5"
                    aria-label="删除记录"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeTask(t.task_id);
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </motion.div>
              );
            })}
          </div>
        )}

        {totalCount > PAGE && (
          <div className="flex items-center justify-end gap-3 mt-4 text-[12px]">
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
            <span className="font-mono text-muted">{page + 1} / {pages}</span>
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
