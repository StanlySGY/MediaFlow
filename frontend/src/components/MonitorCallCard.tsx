import React from 'react';
import { ChevronDown } from 'lucide-react';
import { ASRMonitorCall } from '../types';
import { formatBytes, formatMs, formatSeconds, formatTime, sourceLabel } from '../lib/asrMonitor';

const statusMeta = (status: ASRMonitorCall['status']) => {
  if (status === 'ok') return { text: '成功', dot: 'bg-ok', tone: 'text-fg' };
  if (status === 'error') return { text: '失败', dot: 'bg-err', tone: 'text-err' };
  return { text: '调用中', dot: 'bg-warn', tone: 'text-fg' };
};

/** Only facts that actually carry a value — no rows of bare dashes. */
function facts(call: ASRMonitorCall): [string, string][] {
  const out: [string, string][] = [];
  if (call.segment_id != null) out.push(['分片', String(call.segment_id)]);
  if (call.request_bytes) out.push(['请求', formatBytes(call.request_bytes)]);
  if (call.text_chars) out.push(['文本', `${call.text_chars} 字`]);
  if (call.audio_duration_ms) out.push(['音频', formatSeconds(call.audio_duration_ms / 1000)]);
  if (call.declared_format) {
    const migrated = call.detected_format && call.detected_format !== call.declared_format;
    out.push(['格式', migrated ? `${call.declared_format} → ${call.detected_format}` : call.declared_format]);
  }
  return out;
}

export const MonitorCallCard: React.FC<{ call: ASRMonitorCall }> = ({ call }) => {
  const meta = statusMeta(call.status);
  const summary = facts(call);

  return (
    <details className="panel group">
      <summary className="flex items-start gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-surface-3 transition-colors">
        <span className={`inline-flex items-center gap-1.5 text-sm font-medium shrink-0 ${meta.tone}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
          {meta.text}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm text-fg font-medium">{sourceLabel(call.source)}</span>
            <span className="text-meta text-muted truncate">
              {call.provider} · {call.model}
            </span>
          </div>
          {summary.length > 0 && (
            <div className="text-meta text-muted-2 mt-0.5 truncate">
              {summary.map(([k, v]) => `${k} ${v}`).join(' · ')}
            </div>
          )}
        </div>

        <div className="text-right shrink-0">
          <div className="font-mono text-sm text-fg tabular-nums">{formatMs(call.elapsed_ms)}</div>
          <div className="text-meta text-muted-2">{formatTime(call.started_at)}</div>
        </div>

        <ChevronDown className="w-4 h-4 shrink-0 text-muted-2 mt-0.5 transition-transform group-open:rotate-180" />
      </summary>

      {call.error && (
        <div className="mx-4 mb-3 rounded-[8px] border border-err/30 bg-err-soft px-3 py-2 text-sm text-err break-words">
          {call.error}
        </div>
      )}

      {call.text_preview && (
        <div className="mx-4 mb-3 rounded-[8px] border border-border bg-surface-2 px-3 py-2">
          <div className="text-meta text-muted mb-1">返回文本预览</div>
          <div className="text-sm text-fg leading-relaxed break-words">{call.text_preview}</div>
        </div>
      )}

      <div className="mx-4 mb-4 pt-3 border-t border-border grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
        <Detail label="任务 ID" value={call.task_id} mono />
        <Detail label="会话 ID" value={call.session_id} mono />
        <Detail label="分片" value={call.segment_id != null ? String(call.segment_id) : undefined} mono />
        <Detail
          label="请求 / 文本"
          value={`${formatBytes(call.request_bytes)} / ${call.text_chars} 字`}
        />
        <Detail label="音频时长" value={call.audio_duration_ms ? formatSeconds(call.audio_duration_ms / 1000) : undefined} />
        <Detail label="声明格式" value={call.declared_format} mono />
        <Detail label="检测格式" value={call.detected_format} mono />
        <Detail label="调用 ID" value={call.call_id} mono wide />
      </div>
    </details>
  );
};

const Detail: React.FC<{ label: string; value?: string | null; mono?: boolean; wide?: boolean }> = ({
  label,
  value,
  mono,
  wide,
}) => (
  <div className={wide ? 'col-span-2 md:col-span-4 min-w-0' : 'min-w-0'}>
    <div className="text-meta text-muted">{label}</div>
    <div className={`text-sm text-fg-dim truncate ${mono ? 'font-mono' : ''}`} title={value || undefined}>
      {value || '—'}
    </div>
  </div>
);
