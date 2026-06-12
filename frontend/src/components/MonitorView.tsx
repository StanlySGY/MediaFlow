import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Radio,
  RefreshCcw,
  XCircle,
} from 'lucide-react';
import { ASRMonitorCall, ASRMonitorSnapshot } from '../types';
import { errorMessage } from '../lib/errors';
import {
  LiveStatus,
  MonitorSSEPayload,
  emptySnapshot,
  formatMs,
  liveBadge,
  upsertCall,
} from '../lib/asrMonitor';
import { MonitorCallCard } from './MonitorCallCard';
import { MonitorConfigPanel } from './MonitorConfigPanel';
import { MonitorMetric } from './MonitorMetric';

interface MonitorViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
}

export const MonitorView: React.FC<MonitorViewProps> = ({ authedFetch, sseUrl }) => {
  const [snapshot, setSnapshot] = useState<ASRMonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authedFetch('/asr/monitor');
      if (!response.ok) throw new Error(await response.text());
      setSnapshot(await response.json());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    let alive = true;
    void loadSnapshot();

    if (typeof EventSource === 'undefined') {
      setLiveStatus('stale');
      return () => { alive = false; };
    }

    const es = new EventSource(sseUrl('/asr/monitor/events'));
    es.onopen = () => {
      if (alive) setLiveStatus('live');
    };
    es.onerror = () => {
      if (alive) setLiveStatus('stale');
    };

    const markLive = () => {
      setLastEventAt(Date.now());
      setLiveStatus('live');
    };
    const handleSnapshot = (event: MessageEvent) => {
      if (!alive) return;
      setSnapshot(JSON.parse(event.data) as ASRMonitorSnapshot);
      markLive();
    };
    const handleCallEvent = (event: MessageEvent) => {
      if (!alive) return;
      const payload = JSON.parse(event.data) as MonitorSSEPayload;
      if (payload.snapshot) setSnapshot(payload.snapshot);
      else if (payload.call) setSnapshot((prev) => upsertCall(prev, payload.call as ASRMonitorCall));
      markLive();
    };

    es.addEventListener('snapshot', handleSnapshot);
    es.addEventListener('call_started', handleCallEvent);
    es.addEventListener('call_finished', handleCallEvent);
    es.addEventListener('reset', handleCallEvent);

    return () => {
      alive = false;
      es.close();
    };
  }, [loadSnapshot, sseUrl]);

  const data = snapshot || emptySnapshot();
  const calls = data.calls;
  const badge = useMemo(() => liveBadge(liveStatus), [liveStatus]);

  return (
    <div className="flex flex-col gap-6">
      <div className="card p-6">
        <h3 className="section-title justify-between mb-5">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-accent" />
            <span>上游调用监控</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className={`badge ${badge.cls}`}>
              <span className={`dot ${liveStatus === 'live' ? 'pulse' : ''}`} />
              <span>{badge.text}</span>
            </span>
            <button onClick={loadSnapshot} disabled={loading}>
              <RefreshCcw className="w-4 h-4" />
              <span>刷新</span>
            </button>
          </div>
        </h3>

        {error && (
          <div className="toast err mb-4">
            <AlertTriangle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
          <MonitorMetric
            label="窗口调用"
            value={`${data.summary.total} / ${data.summary.window_size}`}
            hint="最近滚动记录"
            icon={Activity}
          />
          <MonitorMetric label="调用中" value={data.summary.running} icon={Radio} tone="warn" />
          <MonitorMetric label="成功" value={data.summary.succeeded} icon={CheckCircle2} tone="ok" />
          <MonitorMetric label="失败" value={data.summary.failed} icon={XCircle} tone="err" />
          <MonitorMetric label="平均耗时" value={formatMs(data.summary.avg_elapsed_ms)} icon={Clock3} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6">
        <div className="card p-6 min-w-0">
          <h3 className="section-title mb-4">
            <Radio className="w-5 h-5 text-accent" />
            <span>调用明细</span>
            <span className="badge text-[10px]">{calls.length} 条</span>
          </h3>

          {calls.length === 0 ? (
            <div className="panel p-10 text-center text-muted text-sm">
              {loading ? '正在读取监控数据…' : '还没有上游 ASR 调用记录'}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {calls.map((call) => <MonitorCallCard key={call.call_id} call={call} />)}
            </div>
          )}
        </div>

        <MonitorConfigPanel config={data.config} lastEventAt={lastEventAt} />
      </div>
    </div>
  );
};
