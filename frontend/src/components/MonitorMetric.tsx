import React from 'react';

export const MonitorMetric: React.FC<{
  label: string;
  value: string | number;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'ok' | 'warn' | 'err' | 'default';
}> = ({ label, value, hint, icon: Icon, tone = 'default' }) => {
  // State is carried by the number itself; no filled icon tile, no candy box.
  // Zero carries no state: a red "失败 0" or amber "调用中 0" reads as an alarm
  // where there is nothing to alarm about, so the count stays neutral.
  const idle = value === 0 || value === '0';
  const valueTone = {
    ok: 'text-ok',
    warn: 'text-warn',
    err: 'text-err',
    default: 'text-fg',
  }[idle ? 'default' : tone];

  return (
    <div className="panel px-4 py-3 min-h-[72px] flex flex-col justify-center">
      <div className="flex items-center gap-1.5 text-meta text-muted font-medium">
        {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
      </div>
      <div className={`font-mono text-[18px] font-semibold leading-tight mt-1 tabular-nums ${valueTone}`}>
        {value}
      </div>
      {hint && <div className="text-meta text-muted-2 mt-0.5 truncate">{hint}</div>}
    </div>
  );
};
