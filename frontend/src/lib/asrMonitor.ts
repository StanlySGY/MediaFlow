import { ASRMonitorCall, ASRMonitorSnapshot } from '../types';

export type MonitorSSEPayload = {
  type?: string;
  call?: ASRMonitorCall;
  snapshot?: ASRMonitorSnapshot;
};

export type LiveStatus = 'connecting' | 'live' | 'stale';

export const emptySnapshot = (): ASRMonitorSnapshot => ({
  summary: {
    total: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    avg_elapsed_ms: 0,
    window_size: 200,
  },
  calls: [],
});

export const summarize = (
  calls: ASRMonitorCall[],
  windowSize: number,
): ASRMonitorSnapshot['summary'] => {
  const completed = calls.filter((call) => call.status === 'ok' || call.status === 'error');
  const avg = completed.length
    ? completed.reduce((sum, call) => sum + (call.elapsed_ms || 0), 0) / completed.length
    : 0;
  return {
    total: calls.length,
    running: calls.filter((call) => call.status === 'running').length,
    succeeded: calls.filter((call) => call.status === 'ok').length,
    failed: calls.filter((call) => call.status === 'error').length,
    avg_elapsed_ms: Math.round(avg * 10) / 10,
    window_size: windowSize,
  };
};

export const upsertCall = (
  snapshot: ASRMonitorSnapshot | null,
  call: ASRMonitorCall,
): ASRMonitorSnapshot => {
  const base = snapshot || emptySnapshot();
  const windowSize = base.summary.window_size || 200;
  const calls = [call, ...base.calls.filter((item) => item.call_id !== call.call_id)].slice(0, windowSize);
  return {
    ...base,
    summary: summarize(calls, windowSize),
    calls,
  };
};

export const sourceLabel = (source: string) => ({
  file_task: '文件分片',
  realtime_offline: '实时封装',
  stream_transcribe: '流式转写',
  ping: '测试连接',
}[source] || source || '未知来源');

export const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export const formatMs = (value: number) => `${Math.round(value || 0)} ms`;

export const formatSeconds = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest}s`;
};

export const formatTime = (timestamp: number) => {
  if (!timestamp) return '-';
  return new Date(timestamp * 1000).toLocaleTimeString();
};

export const liveBadge = (status: LiveStatus) => {
  if (status === 'live') return { cls: 'ok', text: '实时连接中' };
  if (status === 'connecting') return { cls: 'warn', text: '正在连接' };
  return { cls: 'err', text: '事件流中断' };
};
