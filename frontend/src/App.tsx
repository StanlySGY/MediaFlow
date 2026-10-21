import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Check, CircleStop, Copy, Download, FileArchive, FileText, FolderDown, Hourglass, RotateCcw, Trash2, Undo2, X } from 'lucide-react';

import { useAuth } from './hooks/useAuth';
import { useFileTask } from './hooks/useFileTask';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Dropzone } from './components/Dropzone';
import { Accordion } from './components/Accordion';
import { SegmentList } from './components/SegmentList';
import { RealtimeView } from './components/RealtimeView';
import { RealtimeApiDebugView } from './components/RealtimeApiDebugView';
import { ConfigView } from './components/ConfigView';
import { HistoryView } from './components/HistoryView';
import { ConcatView } from './components/ConcatView';
import { MonitorView } from './components/MonitorView';
import { TokenDialog } from './components/TokenDialog';
import { downloadFile } from './lib/download';
import { DEFAULT_VIEW, parseHash, readQuery, readView, writeQuery, writeView } from './lib/hashRoute';
import { SystemConfig } from './types';

/**
 * Page title + subtitle per view. Declared at module scope because the initial
 * title has to match the view the URL opened, before any handler exists.
 */
const VIEW_META: { [key: string]: { title: string; crumb: string } } = {
  tasks: { title: '文件转写', crumb: '上传音频或视频，自动切分识别，导出完整文本与字幕' },
  concat: { title: '音视频合并', crumb: '多个同格式音频或视频按顺序无损合并，不重新编码' },
  realtime: { title: '实时识别', crumb: '对着麦克风录音，边说边出文字，停止后自动归档' },
  monitor: { title: '调用监控', crumb: '实时查看本进程内的 ASR 上游调用、耗时、状态和错误' },
  config: { title: '服务配置', crumb: '填写并测试 ASR 接口，所有修改即时生效、无需重启' },
  // 手动会话 / 文件分包 / 事件流控制台：验证接口本身用的，不是日常识别路径。
  'api-debug': { title: '接口调试', crumb: '手动创建会话、按包推送音频、查看原始事件流，用于验证上游接口' },
  // Realtime recordings are archived here too, and those rows only open a
  // read-only viewer — "点击可重新打开" was true of file tasks only.
  history: { title: '历史记录', crumb: '查看 7 天内归档的转写任务与录音，文件任务可重新打开，录音可在线查看' },
};

const viewMeta = (view: string) => VIEW_META[view] || VIEW_META[DEFAULT_VIEW];

const serverDefaultText = (value: unknown) =>
  value === undefined || value === null || value === '' ? '服务端默认' : `服务端默认 ${value}`;

export default function App() {
  const {
    token, setToken, authedFetch, sseUrl,
    tokenRequest, openTokenRequest, submitToken, cancelTokenRequest,
  } = useAuth();

  // Topbar / Footer connection info. Declared before useFileTask because the
  // upload preflight reads the limits straight out of this payload.
  const [config, setConfig] = useState<SystemConfig | null>(null);

  // File-transcription lifecycle (upload / SSE / polling / proofreading / export).
  const {
    segments, taskId, taskStatus, taskTotalSegs, taskFinSegs, taskDuration, taskProgress,
    fullText, setFullText,
    ovModel, setOvModel, ovLanguage, setOvLanguage, ovSplit, setOvSplit,
    ovChunk, setOvChunk, ovOverlap, setOvOverlap, ovHotwords, setOvHotwords,
    ovHints, setOvHints, ovTimestamps, setOvTimestamps, setOvTimestampsTouched,
    activePane, setActivePane, copied,
    uploadProgress, mediaUrl, mediaIsVideo, segmentsEdited, mediaRef,
    undoDepth, undoEdit, hasLocalMedia, downloadBundle,
    resetTask, abortTask, retryTask, handleSeek, handleEditSegment, handleFileSelect,
    loadHistoricalTask, statusLabel, downloadSubtitle, handleCopy,
    taskError, clearTaskError, taskErrorHint, taskErrorCode, canRetryTask,
  } = useFileTask(authedFetch, sseUrl, {
    maxBytes: config?.max_upload_bytes,
    allowedExts: config?.allowed_exts,
  });

  // Views Router State. The initial view comes from the URL fragment so a
  // history link (or a refresh on one) opens the page it points at.
  const [currentView, setCurrentView] = useState<string>(() => readView());
  const [viewTitle, setViewTitle] = useState(() => viewMeta(readView()).title);
  const [viewCrumb, setViewCrumb] = useState(() => viewMeta(readView()).crumb);
  // Filters and page for the history list, lifted here because the URL is what
  // makes them shareable: 历史记录 opened from a link keeps its query.
  const [historyNav, setHistoryNav] = useState(0);
  const [historyRoute, setHistoryRoute] = useState(() => {
    const query = readQuery();
    return {
      q: query.get('q') || '',
      status: query.get('status') || '',
      since: query.get('since') || '',
      until: query.get('until') || '',
      page: Math.max(0, parseInt(query.get('page') || '0', 10) || 0),
    };
  });

  const [footStatus, setFootStatus] = useState<{ text: string; status: 'ok' | 'err' | 'warn' | '' }>({ text: '未测试', status: '' });

  // Responsive sidebar (mobile drawer)
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Load backend provider and health status on load
  const refreshTopbar = useCallback(async () => {
    try {
      const r = await authedFetch('/asr/config');
      if (r.ok) {
        const data = await r.json();
        setConfig(data);

        // Reachability probe. This is the audio-free /asr/health, not
        // /asr/ping: ping uploads a 1s silent WAV, so probing it here spent a
        // real upstream ASR call (and a monitored-call slot) on every mount.
        // The full audio round-trip stays on the 测试连接 button in 服务配置.
        const healthResponse = await authedFetch('/asr/health');
        if (!healthResponse.ok) {
          setFootStatus({ text: '连接异常', status: 'err' });
          return;
        }
        const health = await healthResponse.json();
        if (health.ok) {
          setFootStatus({ text: '在线', status: 'ok' });
        } else if (health.configured === false) {
          setFootStatus({ text: '未配置', status: '' });
        } else {
          setFootStatus({ text: '连接断开', status: 'err' });
        }
      }
    } catch {
      setFootStatus({ text: '连接异常', status: 'err' });
    }
  }, [authedFetch]);

  // Auth check + Initial connection probe
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/auth/info');
        const info = await r.json();
        if (info.auth_required && !token) {
          // Ask in the page instead of prompt(): a cancelled dialog leaves the
          // console readable, and a second prompt is not stacked on top of it.
          openTokenRequest('required');
          return;
        }
      } catch {}
      refreshTopbar();
    })();
  }, [token, setToken, refreshTopbar, openTokenRequest]);

  // View routing handler
  const handleViewChange = (view: string) => {
    setCurrentView(view);
    const meta = viewMeta(view);
    setViewTitle(meta.title);
    setViewCrumb(meta.crumb);
    // Leaving a view drops its query: the fragments stay short, and the
    // history filters are not meant to leak into 文件转写.
    writeView(view);
  };

  // Back/forward and hand-edited fragments drive the view.
  useEffect(() => {
    const onHashChange = () => {
      const { view, query } = parseHash(window.location.hash);
      setCurrentView((prev) => {
        if (prev === view) return prev;
        const meta = viewMeta(view);
        setViewTitle(meta.title);
        setViewCrumb(meta.crumb);
        return view;
      });
      if (view === 'history') {
        setHistoryNav((n) => n + 1);
        setHistoryRoute({
          q: query.get('q') || '',
          status: query.get('status') || '',
          since: query.get('since') || '',
          until: query.get('until') || '',
          page: Math.max(0, parseInt(query.get('page') || '0', 10) || 0),
        });
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const setHistoryFilters = (next: { q: string; status: string; since: string; until: string; page: number }) => {
    setHistoryRoute(next);
    writeQuery({
      q: next.q,
      status: next.status,
      since: next.since,
      until: next.until,
      page: next.page > 0 ? next.page : undefined,
    });
  };

  // Token entry point (the key button in the header). submitToken owns the
  // write/clear decision; leaving the field empty clears the session.
  const handleSetToken = () => openTokenRequest('manual');

  // Readiness of the *file* transcription upstream only. The realtime route
  // has its own provider (realtime_asr_provider, default realtime_mock) and is
  // not covered by api_key_set.
  const isReady = !!(config && config.api_key_set) || footStatus.status === 'ok';

  return (
    <div className="app font-sans flex min-h-screen bg-bg text-fg">
      {/* Mobile drawer overlay */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-[45] md:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar navigation */}
      <Sidebar
        currentView={currentView}
        onViewChange={(v) => { handleViewChange(v); setMobileNavOpen(false); }}
        config={config}
        footStatus={footStatus}
        open={mobileNavOpen}
      />

      {/* Main dashboard body */}
      <main className="main flex-1 flex flex-col min-w-0">
        <Header
          title={viewTitle}
          crumb={viewCrumb}
          config={config}
          onSetToken={handleSetToken}
          onToggleNav={() => setMobileNavOpen((v) => !v)}
        />

        <div className="content p-4 md:p-7 max-w-6xl w-full mx-auto flex-1">
          <AnimatePresence mode="wait">

            {/* 1. TASKS ROUTE */}
            {currentView === 'tasks' && (
              <motion.div
                key="tasks"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex flex-col gap-6"
              >
                {/* Beginner guide — shown only until the upstream is configured */}
                {!taskId && !isReady && (
                  <div className="card px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-2">
                    <span className="text-base font-semibold text-fg">快速上手</span>
                    <ol className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm text-muted">
                      <li>1 填写接口地址与密钥</li>
                      <li>2 测试连接</li>
                      <li>3 拖入音频开始转写</li>
                    </ol>
                    <span className="text-[12px] text-muted-2">
                      以上只覆盖文件转写；实时录音默认是演示 provider（不调用真实 ASR），要在配置页换成 realtime_ws / realtime_http 才走真实服务。
                    </span>
                    <span className="flex-1" />
                    <button onClick={() => handleViewChange('config')} className="primary text-[12px] py-1.5 px-3">去配置</button>
                  </div>
                )}

                {/* Upload drag drop panel */}
                <div className="card p-4 sm:p-6">
                  {footStatus.status === 'err' && (
                    <div role="alert" className="flex items-start gap-2.5 rounded-[10px] border border-err/30 bg-err-soft px-4 py-3 mb-4 text-sm text-err">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span className="font-medium">上游 ASR 未连通 · {footStatus.text}</span>
                      <span className="flex-1" />
                      <button onClick={() => handleViewChange('config')} className="text-[12px] py-1 px-2.5">去服务配置</button>
                    </div>
                  )}
                  {taskError && (
                    <div role="alert" className="flex items-start gap-2.5 rounded-[10px] border border-err/30 bg-err-soft px-4 py-3 mb-4 text-sm text-err">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium break-words">{taskError}</div>
                        {taskErrorHint && (
                          <div className="text-[12px] text-muted mt-1 break-words">{taskErrorHint}</div>
                        )}
                        {taskErrorCode && (
                          <div className="font-mono text-meta text-muted-2 mt-1">错误码 {taskErrorCode}</div>
                        )}
                      </div>
                      {canRetryTask && (
                        <button
                          onClick={() => void retryTask()}
                          className="text-[12px] py-1 px-2.5 shrink-0"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>重试</span>
                        </button>
                      )}
                      <button
                        onClick={clearTaskError}
                        aria-label="关闭错误提示"
                        className="ghost w-7 h-7 p-0 shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <Dropzone
                    onFileSelect={handleFileSelect}
                    disabled={taskStatus === 'uploading' || taskStatus === 'processing'}
                    maxBytes={config?.max_upload_bytes}
                    allowedExts={config?.allowed_exts}
                  />

                  {/* Real upload progress */}
                  {uploadProgress >= 0 && (
                    <div className="mt-4">
                      <div className="flex justify-between items-center mb-1.5 text-[12px]">
                        <span className="text-fg-dim font-semibold">正在上传…</span>
                        <span className="font-mono text-accent">{uploadProgress}%</span>
                      </div>
                      <div className="progress" role="progressbar" aria-label="文件上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress}><div style={{ width: `${uploadProgress}%` }} /></div>
                      <p className="hint mt-1.5">大文件上传可能需要一些时间，请不要关闭页面。</p>
                    </div>
                  )}

                  {/* Parameter Accordion Overrides */}
                  <div className="mt-4">
                  <Accordion title="高级选项 · 仅对本次转写生效（留空则用服务端默认值）">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5">
                      <label className="field">
                        <span>模型名称</span>
                        <input type="text" value={ovModel} onChange={e=>setOvModel(e.target.value)} placeholder={serverDefaultText(config?.model)} />
                      </label>
                      <label className="field">
                        <span>识别语言</span>
                        <input type="text" value={ovLanguage} onChange={e=>setOvLanguage(e.target.value)} placeholder={serverDefaultText(config?.language)} />
                        <span className="field-hint">留空自动判断;zh 会按 Chinese 传给模型</span>
                      </label>
                      <label className="field">
                        <span>切分策略</span>
                        <select value={ovSplit} onChange={e=>setOvSplit(e.target.value)}>
                          <option value="">默认（服务端 {serverDefaultText(config?.split_strategy)}）</option>
                          <option value="fixed">fixed（固定时长）</option>
                          <option value="silence">silence（按静音）</option>
                          <option value="overlap">overlap（重叠切分）</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>每片时长（秒）</span>
                        <input type="number" value={ovChunk} onChange={e=>setOvChunk(e.target.value)} placeholder={serverDefaultText(config?.chunk_seconds)} min="5" step="5" />
                      </label>
                      <label className="field">
                        <span>重叠时长（秒）</span>
                        <input type="number" value={ovOverlap} onChange={e=>setOvOverlap(e.target.value)} placeholder={serverDefaultText(config?.overlap_seconds)} min="0" step="0.5" />
                      </label>
                      <label className="field">
                        <span>热词</span>
                        <input type="text" value={ovHotwords} onChange={e=>setOvHotwords(e.target.value)} placeholder={serverDefaultText(config?.hotwords) === '服务端默认' ? '逗号分隔的专有名词' : serverDefaultText(config?.hotwords)} />
                      </label>
                      <label className="field">
                        <span>上下文提示</span>
                        <input type="text" value={ovHints} onChange={e=>setOvHints(e.target.value)} placeholder={serverDefaultText(config?.prompt_hints) === '服务端默认' ? '告诉模型这段音频的背景' : serverDefaultText(config?.prompt_hints)} />
                      </label>

                      <label className="field check">
                        <input
                          type="checkbox"
                          checked={ovTimestamps}
                          onChange={e => {
                            setOvTimestamps(e.target.checked);
                            setOvTimestampsTouched(true);
                          }}
                        />
                        <span>请求逐字时间戳（字幕更精准）{config?.timestamps === false ? ' · 服务端默认关闭' : ''}</span>
                      </label>
                    </div>
                  </Accordion>
                  </div>
                </div>

                {/* Active progress tracking cards panel */}
                {taskId && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="card p-4 sm:p-6"
                  >
                    <h3 className="section-title justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <span>转写进度</span>
                        <span className="font-mono text-meta text-muted-2">#{taskId.slice(0, 16)}…</span>
                      </div>

                      <span className={`badge ${taskStatus === 'done' ? 'ok' : taskStatus === 'failed' ? 'err' : 'warn'}`}>
                        <span className="dot pulse" />
                        <span>{statusLabel(taskStatus)}</span>
                      </span>
                    </h3>

                    {/* Stats details bar */}
                    <div className="flex items-center gap-4 mb-5 flex-wrap">
                      <span className="text-sm text-muted tabular-nums">
                        <b className="text-fg font-medium">{taskFinSegs}</b>
                        <span className="text-muted-2">/</span>
                        <b className="text-fg font-medium">{taskTotalSegs}</b> 分片
                      </span>
                      <span className="text-sm text-muted tabular-nums">
                        <b className="text-fg font-medium">{taskDuration}</b> 时长
                      </span>

                      <div className="progress flex-1 min-w-[200px]" role="progressbar" aria-label="音频转写进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(taskProgress * 100)}>
                        <div style={{ width: `${taskProgress * 100}%` }} />
                      </div>

                      {/* 中止 and 清空 are different requests. Cancelling stops
                          the work but keeps the segments already recognized;
                          clearing only takes this workspace off the screen and
                          lets the task finish in the background, where it shows
                          up in 历史转写记录. */}
                      {(taskStatus === 'processing' || taskStatus === 'uploading' || taskStatus === 'queued') && (
                        <button
                          onClick={() => void abortTask()}
                          title="停止识别，保留已识别出的分片"
                        >
                          <CircleStop className="w-3.5 h-3.5" />
                          <span>中止</span>
                        </button>
                      )}
                      <button
                        onClick={() => void resetTask()}
                        title="清空当前任务与结果"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>清空</span>
                      </button>
                    </div>

                    {/* Local media player — click a segment to seek here and proofread */}
                    {mediaUrl && (
                      <div className="panel p-3 mb-5 flex items-center gap-3">
                        {mediaIsVideo ? (
                          <video ref={mediaRef} src={mediaUrl} controls className="w-full max-h-64 rounded-lg bg-black" />
                        ) : (
                          <audio ref={mediaRef} src={mediaUrl} controls className="w-full" />
                        )}
                      </div>
                    )}

                    {/* Segmented pane controllers. Roving tabindex: the group is
                        one stop in the tab order and the arrows move inside it,
                        which is how a keyboard user switches panes at all. */}
                    <div className="tabs-container" role="tablist" aria-label="识别结果视图"
                      onKeyDown={(e) => {
                        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                        e.preventDefault();
                        setActivePane(activePane === 'live' ? 'final' : 'live');
                      }}>
                      {([['live', `分片明细 (${segments.length})`], ['final', '完整文本']] as const).map(([pane, label]) => (
                        <div
                          key={pane}
                          id={`pane-tab-${pane}`}
                          role="tab"
                          tabIndex={activePane === pane ? 0 : -1}
                          aria-selected={activePane === pane}
                          aria-controls={`pane-${pane}`}
                          onClick={() => setActivePane(pane)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActivePane(pane); } }}
                          className={`tab outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-t-md ${activePane === pane ? 'active' : ''}`}
                        >
                          {label}
                        </div>
                      ))}
                    </div>

                    {/* Sub-panels display */}
                    <div className="mt-4">
                      {activePane === 'live' ? (
                        <div id="pane-live" role="tabpanel" aria-labelledby="pane-tab-live" tabIndex={0} className="pane outline-none">
                          <SegmentList
                            segments={segments}
                            taskId={taskId}
                            authedFetch={authedFetch}
                            onSeek={mediaUrl ? handleSeek : undefined}
                            onEditText={handleEditSegment}
                          />
                          {segments.length === 0 && (
                            <div className="empty flex flex-col items-center justify-center py-14 border border-dashed border-border rounded-lg">
                              <Hourglass className="w-7 h-7 text-muted-2" aria-hidden="true" />
                              <p className="text-muted text-xs mt-3">
                                正在切分音频，马上开始逐片识别…
                              </p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div id="pane-final" role="tabpanel" aria-labelledby="pane-tab-final" tabIndex={0} className="pane flex flex-col gap-4 outline-none">
                          <div className="flex items-start gap-3 flex-wrap">
                            <p className="hint flex-1 min-w-[200px]">
                              {segmentsEdited
                                ? '已应用分片校对，SRT/VTT 按校对后的文本导出。'
                                : '在「分片明细」双击句子校对后，SRT/VTT 会按校对结果导出。'}
                            </p>
                            <button
                              onClick={undoEdit}
                              disabled={undoDepth === 0}
                              title="撤销上一次分片校对"
                              className="text-[12px] px-3 py-1.5"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                              <span>撤销校对{undoDepth > 0 ? `（${undoDepth}）` : ''}</span>
                            </button>
                          </div>
                          <textarea
                            aria-label="完整转写文本"
                            value={fullText}
                            onChange={(e) => setFullText(e.target.value)}
                            placeholder="识别完成后，这里会显示拼接好的完整文本，可在此校对修改…"
                            className="w-full min-h-[300px] border border-border bg-surface-2 p-5 rounded-lg text-sm leading-relaxed text-fg"
                          />

                          <div className="flex items-center gap-3 flex-wrap">
                            <button onClick={handleCopy} className="primary">
                              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                              <span>{copied ? '已复制' : '复制全文'}</span>
                            </button>

                            <span className="text-meta text-muted-2">导出</span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <button onClick={() => downloadSubtitle('srt')} className="text-[12px] px-3 py-1.5">
                                <FolderDown className="w-3.5 h-3.5" />
                                <span>SRT</span>
                              </button>
                              <button onClick={() => downloadSubtitle('vtt')} className="text-[12px] px-3 py-1.5">
                                <FolderDown className="w-3.5 h-3.5" />
                                <span>VTT</span>
                              </button>
                              <button onClick={() => downloadFile(`${taskId}.txt`, fullText, 'text/plain')} className="text-[12px] px-3 py-1.5">
                                <Download className="w-3.5 h-3.5" />
                                <span>TXT</span>
                              </button>
                              <button
                                onClick={async () => {
                                  try {
                                    const r = await authedFetch(`/asr/file/${taskId}/result`);
                                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                                    downloadFile(`${taskId}.json`, await r.text(), 'application/json');
                                  } catch (error) {
                                    window.alert(`JSON 导出失败：${error instanceof Error ? error.message : '请检查连接后重试'}`);
                                  }
                                }}
                                className="text-[12px] px-3 py-1.5"
                              >
                                <FileText className="w-3.5 h-3.5" />
                                <span>JSON</span>
                              </button>
                              {/* The audio only lives in this tab, so the bundle
                                  is offered exactly while it is still here. */}
                              {hasLocalMedia && (
                                <button
                                  onClick={() => void downloadBundle()}
                                  title="音频 + 字幕 + 文本，打包成一个 zip"
                                  className="text-[12px] px-3 py-1.5"
                                >
                                  <FileArchive className="w-3.5 h-3.5" />
                                  <span>完整包</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}

            {/* 2. REALTIME ROUTE */}
            {currentView === 'realtime' && (
              <motion.div
                key="realtime"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <RealtimeView
                  authedFetch={authedFetch}
                  sseUrl={sseUrl}
                  realtimeProvider={config?.realtime_asr_provider}
                  maxSessions={config?.realtime_max_sessions}
                />
              </motion.div>
            )}

            {/* 2b. API DEBUG ROUTE */}
            {currentView === 'api-debug' && (
              <motion.div
                key="api-debug"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <RealtimeApiDebugView
                  authedFetch={authedFetch}
                  sseUrl={sseUrl}
                  maxChunkBytes={config?.realtime_max_chunk_bytes}
                  maxSessionBytes={config?.realtime_max_session_bytes}
                  maxSessionSeconds={config?.realtime_max_session_seconds}
                />
              </motion.div>
            )}

            {/* 3. MONITOR ROUTE */}
            {currentView === 'monitor' && (
              <motion.div
                key="monitor"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <MonitorView authedFetch={authedFetch} sseUrl={sseUrl} />
              </motion.div>
            )}

            {/* 4. CONFIG ROUTE */}
            {currentView === 'config' && (
              <motion.div
                key="config"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <ConfigView authedFetch={authedFetch} refreshTopbar={refreshTopbar} />
              </motion.div>
            )}

            {/* 5. HISTORY ROUTE */}
            {currentView === 'history' && (
              <motion.div
                key="history"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <HistoryView
                  key={historyNav}
                  authedFetch={authedFetch}
                  filters={historyRoute}
                  onFiltersChange={setHistoryFilters}
                  onLoadTask={async (tid) => { if (await loadHistoricalTask(tid)) handleViewChange('tasks'); }}
                  onGoToTasks={() => handleViewChange('tasks')}
                />
              </motion.div>
            )}

            {/* 6. CONCAT ROUTE — audio/video lossless merge */}
            {currentView === 'concat' && (
              <motion.div
                key="concat"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <ConcatView authedFetch={authedFetch} />
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </main>

      {tokenRequest && (
        <TokenDialog
          // A dialog opened for a different reason is a different question, so
          // it gets a fresh mount rather than the previous one's half-typed value.
          key={tokenRequest.reason}
          request={tokenRequest}
          currentToken={token}
          onSubmit={(value) => void submitToken(value)}
          onCancel={cancelTokenRequest}
        />
      )}
    </div>
  );
}
