import React, { useEffect, useRef } from 'react';
import { UploadCloud, Mic, Settings, FolderArchive, BookOpen, AudioLines, Combine, Activity, Microscope } from 'lucide-react';
import { SystemConfig } from '../types';
import { useMediaQuery } from '../hooks/useMediaQuery';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  config: SystemConfig | null;
  footStatus: { text: string; status: 'ok' | 'err' | 'warn' | '' };
  /** Mobile drawer state. Ignored at md and up, where the rail is permanent. */
  open?: boolean;
  /** Close request from a gesture (swipe left) inside the drawer. */
  onRequestClose?: () => void;
}

// Keep in sync with the `md:` breakpoint used below. Below it the rail is a
// drawer that is off-canvas when closed; at and above it, a static column.
const DESKTOP_QUERY = '(min-width: 768px)';
const SWIPE_CLOSE_PX = 56;

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onViewChange,
  config,
  footStatus,
  open = false,
  onRequestClose,
}) => {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const touchStartX = useRef<number | null>(null);
  // The drawer is only translated off-canvas: it stays in the tab order and in
  // the accessibility tree unless it is actually gone. That made the first
  // Tab press on a phone land on 文件转写 inside a menu nobody could see.
  const hiddenFromAssistiveTech = !isDesktop && !open;

  useEffect(() => {
    if (isDesktop) touchStartX.current = null;
  }, [isDesktop]);

  const onTouchStart = (event: React.TouchEvent) => {
    if (isDesktop || !open) return;
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const startX = touchStartX.current;
    touchStartX.current = null;
    if (startX === null) return;
    const endX = event.changedTouches[0]?.clientX;
    if (typeof endX === 'number' && startX - endX > SWIPE_CLOSE_PX) onRequestClose?.();
  };

  const workspaceItems = [
    { id: 'tasks', label: '文件转写', icon: UploadCloud },
    { id: 'realtime', label: '实时识别', icon: Mic },
    { id: 'history', label: '历史记录', icon: FolderArchive },
    { id: 'concat', label: '音视频合并', icon: Combine },
  ];
  const adminItems = [
    { id: 'config', label: '服务配置', icon: Settings },
    { id: 'monitor', label: '调用监控', icon: Activity },
    { id: 'api-debug', label: '接口调试', icon: Microscope },
  ];

  const renderItem = (item: { id: string; label: string; icon: React.ComponentType<{ className?: string }> }) => {
    const Icon = item.icon;
    const isActive = currentView === item.id;
    return (
      <button
        key={item.id}
        onClick={() => onViewChange(item.id)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left cursor-pointer select-none transition-colors duration-150 ${
          isActive
            ? 'bg-accent-soft text-accent'
            : 'text-fg-dim hover:bg-surface-3'
        }`}
      >
        <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-accent' : 'text-muted'}`} />
        <span className={`text-[13px] leading-tight ${isActive ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
      </button>
    );
  };

  return (
    <aside
      id="app-sidebar"
      inert={hiddenFromAssistiveTech}
      aria-hidden={hiddenFromAssistiveTech || undefined}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className={`w-[220px] shrink-0 bg-sidebar border-r border-border flex flex-col h-screen z-50
        fixed md:sticky top-0 transition-transform duration-200
        ${open ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-border">
        <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
          <AudioLines className="w-[18px] h-[18px] text-white" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-[14px] text-fg tracking-tight leading-tight">MediaFlow</div>
          <div className="text-[11px] text-muted leading-tight">音视频处理控制台</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 flex flex-col gap-0.5 overflow-y-auto">
        <div className="px-3 pb-1.5 text-[11px] font-semibold text-muted">工作台</div>
        {workspaceItems.map(renderItem)}

        <div className="mt-4 px-3 pb-1.5 text-[11px] font-semibold text-muted">管理</div>
        {adminItems.map(renderItem)}

        <div className="mt-4 px-3 pb-1.5 text-[11px] font-semibold text-muted">参考文档</div>
        <a href="/docs" target="_blank" rel="noreferrer"
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-fg-dim hover:bg-surface-3 transition-colors">
          <BookOpen className="w-4 h-4 text-muted" />
          <span>接口文档</span>
        </a>
      </nav>

      {/* Footer status */}
      <div className="px-4 py-3.5 border-t border-border flex flex-col gap-2 text-[12px]">
        <div className="flex justify-between items-center gap-2">
          <span className="text-muted shrink-0">上游服务</span>
          <span className="text-fg truncate" title={config?.provider || '—'}>
            {config?.provider || '—'}
          </span>
        </div>
        <div className="flex justify-between items-center gap-2">
          <span className="text-muted shrink-0">模型</span>
          <span className="text-fg truncate" title={config?.model || '—'}>
            {config?.model || '—'}
          </span>
        </div>
        <div className="flex justify-between items-center gap-2">
          <span className="text-muted shrink-0">连接状态</span>
          <span className={`font-semibold flex items-center gap-1.5 ${
            footStatus.status === 'ok' ? 'text-ok'
            : footStatus.status === 'err' ? 'text-err'
            : footStatus.status === 'warn' ? 'text-warn' : 'text-muted'
          }`}>
            {footStatus.status && (
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
            )}
            {footStatus.text}
          </span>
        </div>
        <div className="flex justify-between items-center gap-2">
          <span className="text-muted shrink-0">访问令牌</span>
          <span className="text-fg">
            {config?.access_tokens_count && config.access_tokens_count > 0
              ? `已启用 ${config.access_tokens_count} 个`
              : '未启用'}
          </span>
        </div>
      </div>
    </aside>
  );
};
