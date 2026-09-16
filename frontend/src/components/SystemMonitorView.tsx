import React, { useEffect, useState } from 'react';
import { HardDrive, Activity, Radio } from 'lucide-react';
import { DashboardMetrics, SystemMetrics } from '../types';

interface Props {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
}

export const SystemMonitorView: React.FC<Props> = ({ authedFetch }) => {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [dashboard, setDashboard] = useState<DashboardMetrics | null>(null);

  useEffect(() => {
    void (async () => {
      const [systemResp, dashboardResp] = await Promise.all([
        authedFetch('/asr/metrics/system'),
        authedFetch('/asr/metrics/dashboard'),
      ]);

      if (systemResp.ok) setMetrics(await systemResp.json());
      if (dashboardResp.ok) setDashboard(await dashboardResp.json());
    })();
  }, [authedFetch]);

  if (!metrics) {
    return <div className="card p-6">加载系统监控中…</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      <div className="card p-5">
        <HardDrive className="w-5 h-5 text-accent mb-2" />
        <div>磁盘占用</div>
        <div className="text-2xl font-bold">{metrics.disk_percent}%</div>
      </div>

      <div className="card p-5">
        <Activity className="w-5 h-5 text-accent mb-2" />
        <div>活跃任务</div>
        <div className="text-2xl font-bold">{metrics.active_tasks}</div>
      </div>

      <div className="card p-5">
        <Radio className="w-5 h-5 text-accent mb-2" />
        <div>实时会话</div>
        <div className="text-2xl font-bold">{metrics.realtime_sessions}/{metrics.realtime_limit}</div>
      </div>

      <div className="card p-5">
        <div>Temp / Outputs</div>
        <div className="mt-2 text-sm">Temp: {metrics.temp_size_mb} MB</div>
        <div className="text-sm">Outputs: {metrics.outputs_size_mb} MB</div>
      </div>

      {dashboard && (
        <>
          <div className="card p-5">
            <div>ASR 调用总数</div>
            <div className="text-2xl font-bold">{dashboard.total_calls}</div>
          </div>

          <div className="card p-5">
            <div>成功率</div>
            <div className="text-2xl font-bold">{dashboard.success_rate}%</div>
          </div>

          <div className="card p-5">
            <div>平均耗时</div>
            <div className="text-2xl font-bold">{dashboard.avg_elapsed_ms} ms</div>
          </div>
        </>
      )}
    </div>
  );
};
