import React from 'react';
import { UploadCloud, Mic, Settings, FolderArchive, BookOpen, AudioLines, Combine } from 'lucide-react';
import { SystemConfig } from '../types';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  config: SystemConfig | null;
  footStatus: { text: string; status: 'ok' | 'err' | 'warn' | '' };
  open?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onViewChange,
  config,
  footStatus,
  open = false,
}) => {
  const menuItems = [
    { id: 'tasks', label: '文件转写', desc: '上传音频出文本', icon: UploadCloud },
    { id: 'concat', label: '音视频合并', desc: '多文件无损拼接', icon: Combine },
    { id: 'realtime', label: '实时识别', desc: '边说边出字', icon: Mic },
    { id: 'config', label: '服务配置', desc: '连接 ASR 接口', icon: Settings },
    { id: 'history', label: '历史记录', desc: '查看过往任务', icon: FolderArchive },
  ];

  return (
    <aside
      className={`w-[244px] shrink-0 bg-sidebar border-r border-border flex flex-col h-screen z-50
        fixed md:sticky top-0 transition-transform duration-200
        ${open ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-accent to-accent-2 flex items-center justify-center shadow-md shadow-accent/25">
          <AudioLines className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="font-title font-bold text-[15px] text-fg tracking-tight">MediaFlow</div>
          <div className="text-[10px] text-muted font-mono">音视频处理控制台 v1.4.0</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 flex flex-col gap-1">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left cursor-pointer select-none transition-all duration-150 border ${
                isActive
                  ? 'bg-accent-soft text-accent border-accent/20 shadow-none'
                  : 'text-fg-dim hover:bg-surface-3 border-transparent'
              }`}
            >
              <Icon className={`w-[18px] h-[18px] shrink-0 ${isActive ? 'text-accent' : 'text-muted'}`} />
              <span className="flex flex-col">
                <span className="text-[13px] font-semibold leading-tight">{item.label}</span>
                <span className={`text-[10.5px] leading-tight ${isActive ? 'text-accent/70' : 'text-muted'}`}>{item.desc}</span>
              </span>
            </button>
          );
        })}

        <div className="mt-5 px-3 pb-1.5 text-[10px] font-bold tracking-wider text-muted-2">参考文档</div>

        <a href="/docs" target="_blank" rel="noreferrer"
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-semibold text-fg-dim hover:bg-surface-3 transition-all">
          <BookOpen className="w-[18px] h-[18px] text-muted" />
          <span>接口文档 (Swagger)</span>
        </a>
      </nav>

      {/* Footer status */}
      <div className="p-4 border-t border-border bg-surface-2 flex flex-col gap-2.5 text-[11px]">
        <div className="flex justify-between items-center">
          <span className="text-muted font-medium">上游服务</span>
          <span className="font-mono text-fg-dim truncate max-w-[120px]" title={config?.provider || '—'}>
            {config?.provider || '—'}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-muted font-medium">连接状态</span>
          <span className={`font-semibold font-mono flex items-center gap-1.5 ${
            footStatus.status === 'ok' ? 'text-ok'
            : footStatus.status === 'err' ? 'text-err'
            : footStatus.status === 'warn' ? 'text-warn' : 'text-muted'
          }`}>
            {footStatus.status && (
              <span className={`w-1.5 h-1.5 rounded-full bg-current ${footStatus.status === 'ok' ? 'animate-pulse' : ''}`} />
            )}
            {footStatus.text}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-muted font-medium">访问令牌</span>
          <span className="font-mono text-fg-dim">
            {config?.access_tokens_count && config.access_tokens_count > 0
              ? `已启用 ${config.access_tokens_count} 个`
              : '未启用'}
          </span>
        </div>
      </div>
    </aside>
  );
};
