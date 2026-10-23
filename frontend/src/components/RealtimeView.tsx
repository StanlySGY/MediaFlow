import React from 'react';
import { RealtimeRecorderPanel } from './RealtimeRecorderPanel';

interface RealtimeViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
  realtimeProvider?: string;
  maxSessions?: number;
  onOpenConfig?: () => void;
}

/**
 * 实时识别：一页只做一件事——对着麦克风录音，看文字实时出来。
 *
 * 原先这里还挂着一个「高级设置」折叠面板，里面是手动建会话、文件分包模拟器、
 * 手动 Base64 包和原始事件流控制台。那些是验证服务端接口用的，和「录一段会
 * 议」不是同一条路径，现在搬到「接口调试」视图（RealtimeApiDebugView）。
 */
export const RealtimeView: React.FC<RealtimeViewProps> = ({
  authedFetch,
  sseUrl,
  realtimeProvider,
  maxSessions,
  onOpenConfig,
}) => {
  return (
    <div className="flex flex-col gap-6">
      <RealtimeRecorderPanel
        authedFetch={authedFetch}
        sseUrl={sseUrl}
        realtimeProvider={realtimeProvider}
        maxSessions={maxSessions}
        onOpenConfig={onOpenConfig}
      />
    </div>
  );
};
