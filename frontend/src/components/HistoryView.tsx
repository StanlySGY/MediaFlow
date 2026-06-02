import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Clock, RefreshCw, FolderClosed, Layers } from 'lucide-react';
import { ASRTask } from '../types';
import { errorMessage } from '../lib/errors';

interface HistoryViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onLoadTask: (taskId: string) => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  authedFetch,
  onLoadTask,
}) => {
  const [tasks, setTasks] = useState<ASRTask[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authedFetch('/asr/tasks?limit=50');
      if (r.ok) {
        const data = await r.json();
        setTasks(data.tasks || []);
        setTotalCount(data.total || 0);
      } else {
        throw new Error(`HTTP ${r.status}`);
      }
    } catch (e) {
      setError(`拉取历史归档失败: ${errorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  };

  // Load once on mount; loadHistory is stable for this view's lifetime.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadHistory(); }, []);

  const formatDur = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}h${m}m` : `${m}m${sec}s`;
  };

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
            onClick={loadHistory}
            disabled={loading}
            className="text-[12px] px-3.5 py-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </h3>

        <p className="hint mb-4">点击任意一条记录，可在「文件转写」页重新查看它的分片和完整文本。</p>

        {error && (
          <div className="p-4 rounded-xl border border-err/20 bg-err-soft text-err text-xs font-mono mb-4">
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
            <p>还没有任何已完成的转写任务</p>
            <p className="text-xs text-muted-2 mt-1">去「文件转写」上传一个音频试试吧</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tasks.map((t) => {
              const statusCls = t.status === 'done' ? 'ok' : t.status === 'failed' ? 'err' : 'warn';
              const statusText = t.status === 'done' ? '已完成' : t.status === 'failed' ? '失败' : t.status;

              return (
                <motion.div
                  key={t.task_id}
                  onClick={() => onLoadTask(t.task_id)}
                  whileHover={{ y: -2 }}
                  className="hist-item group"
                >
                  <div className="min-w-0 pr-4">
                    <div className="text-fg font-semibold text-[13.5px] truncate max-w-2xl leading-normal">
                      {t.text || '（暂无文本预览）'}
                    </div>
                    <div className="tid font-mono text-[10px] text-muted mt-1">
                      #{t.task_id}
                    </div>
                  </div>

                  <div className="flex items-center shrink-0 justify-end">
                    <span className={`badge ${statusCls}`}>
                      <span className="dot" />
                      <span>{statusText}</span>
                    </span>
                  </div>

                  <div className="flex items-center shrink-0 justify-end text-[11px] font-mono text-fg-dim gap-1">
                    <Layers className="w-3.5 h-3.5 text-accent" />
                    <span>{t.finished_segments}/{t.total_segments} 片</span>
                  </div>

                  <div className="flex items-center shrink-0 justify-end text-[11px] font-mono text-fg-dim gap-1">
                    <Clock className="w-3.5 h-3.5 text-accent-2" />
                    <span>{formatDur(t.duration || 0)}</span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
