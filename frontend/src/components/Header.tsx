import React from 'react';
import { Cpu, Layers, Key } from 'lucide-react';
import { SystemConfig } from '../types';

interface HeaderProps {
  title: string;
  crumb: string;
  config: SystemConfig | null;
  onSetToken: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  crumb,
  config,
  onSetToken,
}) => {
  return (
    <header className="h-[70px] px-8 flex items-center gap-5 border-b border-white/5 bg-[#070913]/80 backdrop-blur-md sticky top-0 z-40">
      <div className="flex flex-col">
        <h1 className="font-title font-bold text-lg text-white tracking-tight">{title}</h1>
        <span className="text-[11px] text-gray-400 mt-0.5 max-w-[500px] truncate" title={crumb}>{crumb}</span>
      </div>
      
      <div className="flex-1" />
      
      <div className="flex items-center gap-3">
        <div className="text-[11px] font-semibold font-mono flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/3 border border-white/5 text-gray-300">
          <Cpu className="w-3.5 h-3.5 text-[#5c54f2]" />
          <span>模型 <b className="text-white font-bold">{config?.model || '—'}</b></span>
        </div>

        <div className="text-[11px] font-semibold font-mono flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/3 border border-white/5 text-gray-300">
          <Layers className="w-3.5 h-3.5 text-[#8b5cf6]" />
          <span>Provider <b className="text-white font-bold">{config?.provider || '—'}</b></span>
        </div>

        <button
          id="topTokenBtn"
          onClick={onSetToken}
          title="设置访问令牌"
          className="w-8 h-8 rounded-lg bg-white/3 hover:bg-white/7 border border-white/5 text-gray-300 hover:text-white flex items-center justify-center transition-all cursor-pointer"
        >
          <Key className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
