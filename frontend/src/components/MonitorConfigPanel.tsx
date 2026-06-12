import React from 'react';
import { KeyRound, Server } from 'lucide-react';
import { ASRMonitorSnapshot } from '../types';

export const MonitorConfigPanel: React.FC<{
  config?: ASRMonitorSnapshot['config'];
  lastEventAt: number | null;
}> = ({ config, lastEventAt }) => (
  <div className="card p-6 h-fit">
    <h3 className="section-title mb-4">
      <Server className="w-5 h-5 text-accent" />
      <span>当前配置</span>
    </h3>
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="panel p-3">
        <div className="text-muted mb-1">文件 ASR Provider</div>
        <div className="font-mono text-fg break-all">{config?.provider || '-'}</div>
      </div>
      <div className="panel p-3">
        <div className="text-muted mb-1">模型</div>
        <div className="font-mono text-fg break-all">{config?.model || '-'}</div>
      </div>
      <div className="panel p-3">
        <div className="text-muted mb-1">接口地址</div>
        <div className="font-mono text-fg-dim break-all">{config?.base_url || '-'}</div>
      </div>
      <div className="panel p-3">
        <div className="text-muted mb-1">实时 Provider</div>
        <div className="font-mono text-fg break-all">{config?.realtime_asr_provider || '-'}</div>
      </div>
      <div className="panel p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted">
          <KeyRound className="w-4 h-4" />
          <span>API Key</span>
        </div>
        <span className={`badge ${config?.api_key_set ? 'ok' : 'err'}`}>
          {config?.api_key_set ? '已配置' : '未配置'}
        </span>
      </div>
      <div className="text-[11px] text-muted leading-relaxed pt-1">
        {lastEventAt ? `最近事件：${new Date(lastEventAt).toLocaleTimeString()}` : '等待事件流返回调用变化'}
      </div>
    </div>
  </div>
);
