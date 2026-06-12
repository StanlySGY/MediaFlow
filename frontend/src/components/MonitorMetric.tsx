import React from 'react';

export const MonitorMetric: React.FC<{
  label: string;
  value: string | number;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'ok' | 'warn' | 'err' | 'default';
}> = ({ label, value, hint, icon: Icon, tone = 'default' }) => {
  const toneClass = {
    ok: 'text-ok bg-ok-soft border-ok/20',
    warn: 'text-warn bg-warn-soft border-warn/25',
    err: 'text-err bg-err-soft border-err/20',
    default: 'text-accent bg-accent-soft border-accent/20',
  }[tone];

  return (
    <div className="panel p-4 flex items-center gap-3 min-h-[92px]">
      <div className={`w-9 h-9 rounded-lg border flex items-center justify-center ${toneClass}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-muted font-semibold">{label}</div>
        <div className="font-mono text-[22px] font-bold text-fg leading-tight mt-1">{value}</div>
        {hint && <div className="text-[11px] text-muted mt-1 truncate">{hint}</div>}
      </div>
    </div>
  );
};
