import React from 'react';
import { UploadCloud, Mic, Settings, FolderArchive, BookOpen, Star, Radio } from 'lucide-react';
import { SystemConfig } from '../types';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  config: SystemConfig | null;
  footStatus: { text: string; status: 'ok' | 'err' | 'warn' | '' };
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onViewChange,
  config,
  footStatus,
}) => {
  const menuItems = [
    { id: 'tasks', label: '文件任务', icon: UploadCloud },
    { id: 'realtime', label: '实时识别', icon: Mic },
    { id: 'config', label: '服务配置', icon: Settings },
    { id: 'history', label: '历史任务', icon: FolderArchive },
  ];

  return (
    <aside className="w-[250px] shrink-0 bg-[#0b0e1a] border-r border-white/5 flex flex-col sticky top-0 h-100vh z-50">
      {/* Brand logo */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-white/5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-[#5c54f2] to-[#8b5cf6] flex items-center justify-center shadow-lg shadow-[#5c54f2]/20">
          <Radio className="w-5 h-5 text-white animate-pulse" />
        </div>
        <div>
          <div className="font-title font-bold text-[15px] text-white tracking-tight">AudioFlow ASR</div>
          <div className="text-[10px] text-gray-500 font-mono">v1.2.0</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-5 px-3 flex flex-col gap-1">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <div
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-[13px] font-semibold cursor-pointer select-none transition-all duration-200 ${
                isActive
                  ? 'bg-[#5c54f2]/10 text-white border-l-4 border-[#5c54f2]'
                  : 'text-gray-400 hover:bg-white/5 hover:text-white hover:translate-x-0.5'
              }`}
            >
              <Icon className={`w-4.5 h-4.5 ${isActive ? 'text-[#5c54f2]' : 'opacity-80'}`} />
              <span>{item.label}</span>
            </div>
          );
        })}

        <div className="mt-5 px-4 pb-2 text-[10px] font-bold uppercase tracking-wider text-gray-600">
          参考
        </div>
        
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-[13px] text-gray-400 hover:bg-white/5 hover:text-white transition-all"
        >
          <BookOpen className="w-4.5 h-4.5 opacity-80" />
          <span>API 文档</span>
        </a>

        <a
          href="https://github.com/StanlySGY/AudioFlow-ASR"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-[13px] text-gray-400 hover:bg-white/5 hover:text-white transition-all"
        >
          <Star className="w-4.5 h-4.5 opacity-80" />
          <span>GitHub</span>
        </a>
      </nav>

      {/* Footer stats */}
      <div className="p-5 border-t border-white/5 bg-black/10 flex flex-col gap-2 text-[11px] text-gray-400">
        <div className="flex justify-between items-center">
          <span className="text-gray-500 font-medium">上游后端</span>
          <span className="font-mono text-gray-300 truncate max-w-[120px]" title={config?.provider || '—'}>
            {config?.provider || '—'}
          </span>
        </div>
        
        <div className="flex justify-between items-center">
          <span className="text-gray-500 font-medium">连接状态</span>
          <span
            className={`font-semibold font-mono flex items-center gap-1.5 ${
              footStatus.status === 'ok'
                ? 'text-[#10b981] drop-shadow-[0_0_8px_rgba(16,185,129,0.3)]'
                : footStatus.status === 'err'
                ? 'text-[#ef4444] drop-shadow-[0_0_8px_rgba(239,68,68,0.3)]'
                : 'text-gray-400'
            }`}
          >
            {footStatus.status && (
              <span className={`w-1.5 h-1.5 rounded-full bg-current ${footStatus.status === 'ok' || footStatus.status === 'err' ? 'animate-ping' : ''}`} />
            )}
            {footStatus.text}
          </span>
        </div>
        
        <div className="flex justify-between items-center">
          <span className="text-gray-500 font-medium">配置令牌</span>
          <span className="font-mono text-gray-300">
            {config?.access_tokens_count && config.access_tokens_count > 0
              ? `${config.access_tokens_count} 个`
              : '未启用'}
          </span>
        </div>
      </div>
    </aside>
  );
};
