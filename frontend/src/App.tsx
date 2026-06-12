import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, FileText, FolderDown, Check, Download, Copy } from 'lucide-react';

import { useAuth } from './hooks/useAuth';
import { useFileTask } from './hooks/useFileTask';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Dropzone } from './components/Dropzone';
import { Accordion } from './components/Accordion';
import { SegmentList } from './components/SegmentList';
import { RealtimeView } from './components/RealtimeView';
import { ConfigView } from './components/ConfigView';
import { HistoryView } from './components/HistoryView';
import { ConcatView } from './components/ConcatView';
import { MonitorView } from './components/MonitorView';
import { downloadFile } from './lib/download';
import { SystemConfig } from './types';

export default function App() {
  const { token, setToken, authedFetch, sseUrl } = useAuth();
  const standardWavInputRef = useRef<HTMLInputElement>(null);

  // File-transcription lifecycle (upload / SSE / polling / proofreading / export).
  const {
    segments, taskId, taskStatus, taskTotalSegs, taskFinSegs, taskDuration, taskProgress,
    fullText, setFullText,
    ovModel, setOvModel, ovLanguage, setOvLanguage, ovSplit, setOvSplit,
    ovChunk, setOvChunk, ovOverlap, setOvOverlap, ovHotwords, setOvHotwords,
    ovHints, setOvHints, ovTimestamps, setOvTimestamps, setOvTimestampsTouched,
    activePane, setActivePane, copied,
    uploadProgress, mediaUrl, mediaIsVideo, segmentsEdited, mediaRef,
    resetTask, handleSeek, handleEditSegment, handleFileSelect,
    loadHistoricalTask, statusLabel, downloadSubtitle, handleCopy,
  } = useFileTask(authedFetch, sseUrl);

  // Views Router State
  const [currentView, setCurrentView] = useState<string>('tasks');
  const [viewTitle, setViewTitle] = useState('文件转写');
  const [viewCrumb, setViewCrumb] = useState('上传音频或视频，自动切分识别，导出完整文本与字幕');

  // Topbar / Footer connection info
  const [config, setConfig] = useState<SystemConfig | null>(null);
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

        // Connectivity probe
        const pingResponse = await authedFetch('/asr/ping', { method: 'POST' });
        const pingData = await pingResponse.json();
        if (pingData.ok) {
          setFootStatus({ text: '在线', status: 'ok' });
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
          const tok = prompt('需要访问令牌（已启用鉴权）');
          if (tok) setToken(tok.trim());
        }
      } catch {}
      refreshTopbar();
    })();
  }, [token, setToken, refreshTopbar]);

  // View routing handler
  const handleViewChange = (view: string) => {
    setCurrentView(view);
    const routerMeta: { [key: string]: { title: string; crumb: string } } = {
      tasks: { title: '文件转写', crumb: '上传音频或视频，自动切分识别，导出完整文本与字幕' },
      concat: { title: '音视频合并', crumb: '多个同格式音频或视频按顺序无损合并，不重新编码' },
      realtime: { title: '实时识别', crumb: '创建会话后边发音频边出结果，适合直播、会议等实时场景' },
      monitor: { title: '调用监控', crumb: '实时查看 Qwen ASR 上游调用、耗时、状态和错误' },
      config: { title: '服务配置', crumb: '填写并测试 ASR 接口，所有修改即时生效、无需重启' },
      history: { title: '历史记录', crumb: '查看以往已完成的转写任务，点击可重新打开' },
    };

    if (routerMeta[view]) {
      setViewTitle(routerMeta[view].title);
      setViewCrumb(routerMeta[view].crumb);
    }
  };

  const handleSetToken = () => {
    const tok = prompt('访问令牌（留空 = 清除）', token);
    if (tok !== null) {
      setToken(tok.trim());
      refreshTopbar();
    }
  };

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
                {/* Beginner step guide */}
                {!taskId && (
                  <div className="card p-6">
                    <h3 className="section-title mb-1">
                      <span className="text-accent">快速上手</span>
                      <span className="section-sub">第一次使用？按下面三步来</span>
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                      <div className="step" style={{ borderColor: isReady ? 'var(--color-ok)' : 'var(--color-accent)' }}>
                        <span className="num" style={{ background: isReady ? 'var(--color-ok-soft)' : 'var(--color-accent-soft)', color: isReady ? 'var(--color-ok)' : 'var(--color-accent)' }}>
                          {isReady ? '✓' : '1'}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-fg">配置 ASR 接口</div>
                          <div className="text-[11.5px] text-muted mt-0.5">填写接口地址、密钥、模型</div>
                          {!isReady && (
                            <button onClick={() => handleViewChange('config')} className="primary mt-2 text-[12px] py-1.5 px-3">去配置</button>
                          )}
                        </div>
                      </div>
                      <div className="step border-border">
                        <span className="num bg-surface-3 text-fg-dim">2</span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-fg">测试连接</div>
                          <div className="text-[11.5px] text-muted mt-0.5">在「服务配置」点「测试连接」确认上游可用</div>
                        </div>
                      </div>
                      <div className="step border-border">
                        <span className="num bg-surface-3 text-fg-dim">3</span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-fg">上传音频</div>
                          <div className="text-[11.5px] text-muted mt-0.5">把文件拖到下方，等待自动转写完成</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Upload drag drop panel */}
                <div className="card p-6">
                  <Dropzone onFileSelect={handleFileSelect} disabled={taskStatus === 'uploading' || taskStatus === 'processing'} />

                  <div className="panel p-3 mt-4 flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-fg">标准文件流式转写</div>
                      <div className="text-[11.5px] text-muted mt-0.5">POST /asr/file · SSE /asr/file/&lt;task_id&gt;/events</div>
                    </div>
                    <input
                      ref={standardWavInputRef}
                      type="file"
                      accept=".wav,audio/wav,audio/x-wav"
                      hidden
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0];
                        if (file) void handleFileSelect(file);
                        e.currentTarget.value = '';
                      }}
                    />
                    <button
                      onClick={() => standardWavInputRef.current?.click()}
                      disabled={taskStatus === 'uploading' || taskStatus === 'processing'}
                      className="primary"
                    >
                      <FileText className="w-4 h-4" />
                      <span>标准上传 WAV 流式接口</span>
                    </button>
                  </div>

                  {/* Real upload progress */}
                  {uploadProgress >= 0 && (
                    <div className="mt-4">
                      <div className="flex justify-between items-center mb-1.5 text-[12px]">
                        <span className="text-fg-dim font-semibold">正在上传…</span>
                        <span className="font-mono text-accent">{uploadProgress}%</span>
                      </div>
                      <div className="progress"><div style={{ width: `${uploadProgress}%` }} /></div>
                      <p className="hint mt-1.5">大文件上传可能需要一些时间，请不要关闭页面。</p>
                    </div>
                  )}

                  {/* Parameter Accordion Overrides */}
                  <div className="mt-4">
                  <Accordion title="高级选项 · 仅对本次转写生效（留空则用服务端默认值）">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5">
                      <label className="field">
                        <span>模型名称</span>
                        <input type="text" value={ovModel} onChange={e=>setOvModel(e.target.value)} placeholder="qwen3-asr-flash" />
                      </label>
                      <label className="field">
                        <span>识别语言</span>
                        <input type="text" value={ovLanguage} onChange={e=>setOvLanguage(e.target.value)} placeholder="zh / en / 留空自动" />
                      </label>
                      <label className="field">
                        <span>切分策略</span>
                        <select value={ovSplit} onChange={e=>setOvSplit(e.target.value)}>
                          <option value="">默认</option>
                          <option value="fixed">fixed（固定时长）</option>
                          <option value="silence">silence（按静音）</option>
                          <option value="overlap">overlap（重叠切分）</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>每片时长（秒）</span>
                        <input type="number" value={ovChunk} onChange={e=>setOvChunk(e.target.value)} placeholder="30" min="5" step="5" />
                      </label>
                      <label className="field">
                        <span>重叠时长（秒）</span>
                        <input type="number" value={ovOverlap} onChange={e=>setOvOverlap(e.target.value)} placeholder="2" min="0" step="0.5" />
                      </label>
                      <label className="field">
                        <span>热词</span>
                        <input type="text" value={ovHotwords} onChange={e=>setOvHotwords(e.target.value)} placeholder="逗号分隔的专有名词" />
                      </label>
                      <label className="field">
                        <span>上下文提示</span>
                        <input type="text" value={ovHints} onChange={e=>setOvHints(e.target.value)} placeholder="告诉模型这段音频的背景" />
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
                        <span>请求逐字时间戳（字幕更精准）</span>
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
                    className="card p-6"
                  >
                    <h3 className="section-title justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <span>转写进度</span>
                        <span className="font-mono text-xs text-muted">#{taskId.slice(0, 16)}…</span>
                      </div>

                      <span className={`badge ${taskStatus === 'done' ? 'ok' : taskStatus === 'failed' ? 'err' : 'warn'}`}>
                        <span className="dot pulse" />
                        <span>{statusLabel(taskStatus)}</span>
                      </span>
                    </h3>

                    {/* Stats details bar */}
                    <div className="row gap-4 mb-6 items-center flex-wrap">
                      <span className="badge">已识别分片 <b className="text-fg ml-1 font-mono">{taskFinSegs}/{taskTotalSegs}</b></span>
                      <span className="badge">音频时长 <b className="text-fg ml-1 font-mono">{taskDuration}</b></span>

                      <div className="progress flex-1 min-w-[200px]">
                        <div style={{ width: `${taskProgress * 100}%` }} />
                      </div>

                      <button onClick={resetTask}>
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

                    {/* Segmented pane controllers */}
                    <div className="tabs-container" role="tablist">
                      {([['live', `分片明细 (${segments.length})`], ['final', '完整文本']] as const).map(([pane, label]) => (
                        <div
                          key={pane}
                          role="tab"
                          tabIndex={0}
                          aria-selected={activePane === pane}
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
                        <div className="pane">
                          <SegmentList
                            segments={segments}
                            taskId={taskId}
                            authedFetch={authedFetch}
                            onSeek={mediaUrl ? handleSeek : undefined}
                            onEditText={handleEditSegment}
                          />
                          {segments.length === 0 && (
                            <div className="empty flex flex-col items-center justify-center py-14 border border-dashed border-border rounded-xl">
                              <span className="ico text-3xl">⏳</span>
                              <p className="text-muted text-xs mt-3">
                                正在切分音频，马上开始逐片识别…
                              </p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="pane flex flex-col gap-4">
                          <p className="hint">
                            可在下方编辑完整文本后「复制全文」或「下载 TXT」。
                            {segmentsEdited
                              ? '已应用分片校对：SRT/VTT 将按你校对后的分片文本导出。'
                              : '若需精修字幕，可在「分片明细」里双击逐句校对，再回到这里导出 SRT/VTT。'}
                          </p>
                          <textarea
                            value={fullText}
                            onChange={(e) => setFullText(e.target.value)}
                            placeholder="识别完成后，这里会显示拼接好的完整文本，可在此校对修改…"
                            className="w-full min-h-[300px] border border-border bg-surface-2 p-5 rounded-xl text-sm leading-relaxed text-fg"
                          />

                          <div className="flex gap-2.5 flex-wrap">
                            <button onClick={handleCopy} className="primary">
                              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                              <span>{copied ? '已复制' : '复制全文'}</span>
                            </button>

                            <button onClick={() => downloadFile(`${taskId}.txt`, fullText, 'text/plain')}>
                              <Download className="w-4 h-4" />
                              <span>下载 TXT</span>
                            </button>

                            <button onClick={async () => {
                              const r = await authedFetch(`/asr/file/${taskId}/result`);
                              if (r.ok) downloadFile(`${taskId}.json`, await r.text(), 'application/json');
                            }}>
                              <FileText className="w-4 h-4" />
                              <span>下载 JSON</span>
                            </button>

                            <button onClick={() => downloadSubtitle('srt')}>
                              <FolderDown className="w-4 h-4" />
                              <span>导出 SRT</span>
                            </button>

                            <button onClick={() => downloadSubtitle('vtt')}>
                              <FolderDown className="w-4 h-4" />
                              <span>导出 VTT</span>
                            </button>
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
                <RealtimeView authedFetch={authedFetch} sseUrl={sseUrl} />
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
                  authedFetch={authedFetch}
                  onLoadTask={async (tid) => { if (await loadHistoricalTask(tid)) handleViewChange('tasks'); }}
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
    </div>
  );
}
