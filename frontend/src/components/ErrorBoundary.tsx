import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defence for the console.
 *
 * Without one, a single render throw during a recording or an upload leaves a
 * white page with no way back — and the work in memory (the uploaded file, the
 * live transcript) is gone. This keeps the shell, says what happened, and
 * offers a reload that preserves the current view.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The console's own logs are the only place this ends up; there is no
    // client-side telemetry, and the message is what a user can paste back.
    console.error('MediaFlow UI crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-bg text-fg">
        <div className="card p-6 max-w-[560px] w-full">
          <h1 className="text-title font-semibold mb-2">页面出现错误</h1>
          <p className="text-sm text-muted leading-relaxed mb-4">
            当前页面无法继续渲染。正在进行的任务在服务端可能仍在运行，
            刷新后会从历史记录或任务地址恢复。
          </p>
          <pre className="text-meta font-mono bg-console text-console-text border border-console-border rounded-lg p-3 overflow-auto max-h-[200px] mb-4 whitespace-pre-wrap">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <button className="primary" onClick={() => window.location.reload()}>
              刷新页面
            </button>
            <button
              onClick={() => {
                // Back to a state the app is known to render: the workspace.
                window.location.hash = '#/tasks';
                this.setState({ error: null });
              }}
            >
              回到文件转写
            </button>
          </div>
        </div>
      </div>
    );
  }
}
