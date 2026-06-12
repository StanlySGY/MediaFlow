import React from 'react';
import { CheckCircle2, Radio, XCircle } from 'lucide-react';
import { ASRMonitorCall } from '../types';
import { formatBytes, formatMs, formatTime, sourceLabel } from '../lib/asrMonitor';

const statusMeta = (status: ASRMonitorCall['status']) => {
  if (status === 'ok') return { text: '成功', cls: 'ok', icon: CheckCircle2 };
  if (status === 'error') return { text: '失败', cls: 'err', icon: XCircle };
  return { text: '调用中', cls: 'warn', icon: Radio };
};

export const MonitorCallCard: React.FC<{ call: ASRMonitorCall }> = ({ call }) => {
  const meta = statusMeta(call.status);
  const Icon = meta.icon;

  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`badge ${meta.cls}`}>
              <Icon className="w-3.5 h-3.5" />
              <span>{meta.text}</span>
            </span>
            <span className="badge">{sourceLabel(call.source)}</span>
            <span className="font-mono text-[12px] text-fg-dim truncate max-w-full">
              {call.provider} · {call.model}
            </span>
          </div>
          <div className="text-[11px] text-muted font-mono mt-2 truncate">
            {call.call_id}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-[13px] font-bold text-fg">{formatMs(call.elapsed_ms)}</div>
          <div className="text-[11px] text-muted">{formatTime(call.started_at)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-[12px]">
        <div>
          <div className="text-muted">任务 ID</div>
          <div className="font-mono text-fg-dim truncate">{call.task_id || '-'}</div>
        </div>
        <div>
          <div className="text-muted">会话 ID</div>
          <div className="font-mono text-fg-dim truncate">{call.session_id || '-'}</div>
        </div>
        <div>
          <div className="text-muted">分片</div>
          <div className="font-mono text-fg-dim">{call.segment_id ?? '-'}</div>
        </div>
        <div>
          <div className="text-muted">请求 / 文本</div>
          <div className="font-mono text-fg-dim">{formatBytes(call.request_bytes)} / {call.text_chars} 字</div>
        </div>
      </div>

      {call.error && (
        <div className="toast err mt-3 max-w-full">
          <span className="break-all">{call.error}</span>
        </div>
      )}
    </div>
  );
};
