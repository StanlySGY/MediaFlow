import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Clock, RefreshCw, FolderClosed, Layers, Eye } from 'lucide-react';
import { ASRTask } from '../types';

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
    } catch (e: any) {
      setError(`拉取历史归档失败: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const formatDur = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}h${m}m` : `${m}m${sec}s`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="border border-white/5 bg-white/2 rounded-2xl p-6 backdrop-blur-md">
        <h3 className="font-title text-base font-bold text-white flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <FolderClosed className="w-5 h-5 text-[#5c54f2]" />
            <span>转写任务历史归档</span>
            <span className="badge text-xs scale-90">{totalCount} 个已保存任务</span>
          </div>

          <button
            onClick={loadHistory}
            disabled={loading}
            className="text-[12px] px-3.5 py-1.5 rounded-lg font-semibold flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新归档</span>
          </button>
        </h3>

        {error && (
          <div className="p-4 rounded-xl border border-[#ef4444]/20 bg-[#ef4444]/5 text-[#ef4444] text-xs font-mono mb-4">
            {error}
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <div className="text-gray-500 font-mono text-xs text-center py-20 animate-pulse">
            正在拉取输出归档目录...
          </div>
        ) : tasks.length === 0 ? (
          <div className="hist-empty py-16">
            <FolderClosed className="w-10 h-10 mx-auto opacity-20 text-gray-500 mb-3" />
            <p>暂无任何已持久化的历史转写记录</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tasks.map((t) => {
              const statusCls = t.status === 'done' ? 'ok' : t.status === 'failed' ? 'err' : 'warn';
              
              return (
                <motion.div
                  key={t.task_id}
                  onClick={() => onLoadTask(t.task_id)}
                  whileHover={{ y: -2, scale: 1.002 }}
                  className="hist-item group"
                >
                  <div className="min-w-0 pr-4">
                    <div className="text-gray-200 font-semibold text-[13.5px] truncate max-w-2xl leading-normal group-hover:text-white transition-colors">
                      {t.text || '(暂无预览内容)'}
                    </div>
                    <div className="tid font-mono text-[10px] text-gray-500 mt-1">
                      #{t.task_id}
                    </div>
                  </div>

                  <div className="flex items-center shrink-0 justify-end">
                    <span className={`badge ${statusCls}`}>
                      <span className="dot pulse" />
                      <span>{t.status}</span>
                    </span>
                  </div>

                  <div className="flex items-center shrink-0 justify-end text-[11px] font-mono text-gray-400 gap-1">
                    <Layers className="w-3.5 h-3.5 text-[#5c54f2]" />
                    <span>{t.finished_segments}/{t.total_segments} 片</span>
                  </div>

                  <div className="flex items-center shrink-0 justify-end text-[11px] font-mono text-gray-400 gap-1">
                    <Clock className="w-3.5 h-3.5 text-[#8b5cf6]" />
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
