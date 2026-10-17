import React from 'react';
import { Server } from 'lucide-react';
import { ASRMonitorSnapshot } from '../types';

const Row: React.FC<{ label: string; value?: string | null; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-baseline gap-3 py-1.5">
    <span className="text-meta text-muted w-[86px] shrink-0">{label}</span>
    <span
      className={`text-sm text-fg break-all min-w-0 ${mono ? 'font-mono' : ''}`}
      title={value || undefined}
    >
      {value || '—'}
    </span>
  </div>
);

export const MonitorConfigPanel: React.FC<{
  config?: ASRMonitorSnapshot['config'];
  lastEventAt: number | null;
}> = ({ config, lastEventAt }) => (
  <div className="card p-5 h-fit">
    <h3 className="section-title mb-3">
      <Server className="w-4 h-4 text-muted" />
      <span>当前配置</span>
    </h3>

    <div className="divide-y divide-border">
      <Row label="文件 Provider" value={config?.provider} mono />
      <Row label="模型" value={config?.model} mono />
      <Row label="接口地址" value={config?.base_url} mono />
      <Row label="实时 Provider" value={config?.realtime_asr_provider} mono />
      <Row
        label="API Key"
        value={config?.api_key_set ? '已配置' : '未配置'}
      />
    </div>

    <div className="text-meta text-muted-2 leading-relaxed pt-3 mt-1 border-t border-border">
      {lastEventAt ? `最近事件 ${new Date(lastEventAt).toLocaleTimeString()}` : '等待事件流返回调用变化'}
    </div>
  </div>
);
