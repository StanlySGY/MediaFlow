import React from 'react';
import { Cpu, Layers, Key, Menu } from 'lucide-react';
import { SystemConfig } from '../types';

interface HeaderProps {
  title: string;
  crumb: string;
  config: SystemConfig | null;
  onSetToken: () => void;
  onToggleNav?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  crumb,
  config,
  onSetToken,
  onToggleNav,
}) => {
  return (
    <header className="h-[68px] px-5 md:px-7 flex items-center gap-3 md:gap-5 border-b border-border bg-surface/90 backdrop-blur-md sticky top-0 z-40">
      <button
        onClick={onToggleNav}
        aria-label="打开菜单"
        className="md:hidden w-9 h-9 rounded-lg bg-surface-2 border border-border text-fg-dim flex items-center justify-center p-0 shrink-0"
      >
        <Menu className="w-4 h-4" />
      </button>

      <div className="flex flex-col min-w-0">
        <h1 className="font-title font-bold text-[16px] md:text-[17px] text-fg tracking-tight">{title}</h1>
        <span className="text-[11.5px] text-muted mt-0.5 max-w-[560px] truncate hidden sm:block" title={crumb}>{crumb}</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2.5">
        <div className="text-[11px] font-semibold font-mono items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2 border border-border text-fg-dim hidden lg:flex">
          <Cpu className="w-3.5 h-3.5 text-accent" />
          <span>模型 <b className="text-fg font-bold">{config?.model || '未设置'}</b></span>
        </div>

        <div className="text-[11px] font-semibold font-mono items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2 border border-border text-fg-dim hidden lg:flex">
          <Layers className="w-3.5 h-3.5 text-accent-2" />
          <span>接口 <b className="text-fg font-bold">{config?.provider || '未设置'}</b></span>
        </div>

        <button
          onClick={onSetToken}
          title="设置访问令牌"
          aria-label="设置访问令牌"
          className="w-9 h-9 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border text-fg-dim hover:text-fg flex items-center justify-center transition-all cursor-pointer p-0"
        >
          <Key className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
