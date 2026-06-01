import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Play, 
  Trash2, 
  FileText, 
  FolderDown, 
  Settings, 
  Radio, 
  Activity, 
  Loader2, 
  Check, 
  Download,
  Copy
} from 'lucide-react';

import { useAuth } from './hooks/useAuth';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Dropzone } from './components/Dropzone';
import { Accordion } from './components/Accordion';
import { SegmentList } from './components/SegmentList';
import { RealtimeView } from './components/RealtimeView';
import { ConfigView } from './components/ConfigView';
import { HistoryView } from './components/HistoryView';

import { ASRSegment, ASRTask, SystemConfig } from './types';

// Mirror the backend's segment-level subtitle output (app/services/subtitles.py) so locally
// proofread segment text can be exported to SRT/VTT without a server round-trip.
const fmtSubtitleTime = (sec: number, comma: boolean): string => {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  let s = Math.floor(sec % 60);
  let ms = Math.round((sec - Math.floor(sec)) * 1000);
  if (ms === 1000) { ms = 0; s += 1; }
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${comma ? ',' : '.'}${p(ms, 3)}`;
};

const subtitleEntries = (segs: ASRSegment[]) =>
  [...segs]
    .sort((a, b) => a.segment_id - b.segment_id)
    .filter((s) => s.text && s.text.trim() && !s.error)
    .map((s) => ({ start: s.start, end: s.end <= s.start ? s.start + 0.1 : s.end, text: s.text.trim() }));

const buildSrt = (segs: ASRSegment[]): string =>
  subtitleEntries(segs)
    .map((e, i) => `${i + 1}\n${fmtSubtitleTime(e.start, true)} --> ${fmtSubtitleTime(e.end, true)}\n${e.text}\n`)
    .join('\n');

const buildVtt = (segs: ASRSegment[]): string => {
  const body = ['WEBVTT', ''];
  subtitleEntries(segs).forEach((e, i) => {
    body.push(String(i + 1), `${fmtSubtitleTime(e.start, false)} --> ${fmtSubtitleTime(e.end, false)}`, e.text, '');
  });
  return body.join('\n');
};

export default function App() {
  const { token, setToken, authedFetch, sseUrl } = useAuth();
  
  // Views Router State
  const [currentView, setCurrentView] = useState<string>('tasks');
  const [viewTitle, setViewTitle] = useState('文件转写');
  const [viewCrumb, setViewCrumb] = useState('上传音频或视频，自动切分识别，导出完整文本与字幕');

  // Topbar / Footer connection info
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [footStatus, setFootStatus] = useState<{ text: string; status: 'ok' | 'err' | 'warn' | '' }>({ text: '未测试', status: '' });

  // Task View State
  const [segments, setSegments] = useState<ASRSegment[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<string>('—');
  const [taskTotalSegs, setTaskTotalSegs] = useState<number | string>('—');
  const [taskFinSegs, setTaskFinSegs] = useState<number>(0);
  const [taskDuration, setTaskDuration] = useState<string>('—');
  const [taskProgress, setTaskProgress] = useState<number>(0);
  const [fullText, setFullText] = useState<string>('');
  
  // Accordion parameters overrides
  const [ovModel, setOvModel] = useState('');
  const [ovLanguage, setOvLanguage] = useState('');
  const [ovSplit, setOvSplit] = useState('');
  const [ovChunk, setOvChunk] = useState('');
  const [ovOverlap, setOvOverlap] = useState('');
  const [ovHotwords, setOvHotwords] = useState('');
  const [ovHints, setOvHints] = useState('');
  const [ovTimestamps, setOvTimestamps] = useState(true);
  const [ovTimestampsTouched, setOvTimestampsTouched] = useState(false);

  // Tabs pane selection
  const [activePane, setActivePane] = useState<'live' | 'final'>('live');
  const [copied, setCopied] = useState(false);

  // Responsive sidebar (mobile drawer)
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Real upload progress (0-100, -1 = not uploading)
  const [uploadProgress, setUploadProgress] = useState(-1);
  // Local media for click-to-seek playback proofreading
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaIsVideo, setMediaIsVideo] = useState(false);
  // Whether any segment text was locally edited (drives front-end subtitle export)
  const [segmentsEdited, setSegmentsEdited] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<any>(null);
  const mediaRef = useRef<HTMLAudioElement & HTMLVideoElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

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
          setFootStatus({
            text: '在线',
            status: 'ok',
          });
        } else {
          setFootStatus({
            text: '连接断开',
            status: 'err',
          });
        }
      }
    } catch (e) {
      setFootStatus({
        text: '连接异常',
        status: 'err',
      });
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
      } catch (e) {}
      refreshTopbar();
    })();
  }, [token, setToken, refreshTopbar]);

  // View routing handler
  const handleViewChange = (view: string) => {
    setCurrentView(view);
    const routerMeta: { [key: string]: { title: string; crumb: string } } = {
      tasks: { title: '文件转写', crumb: '上传音频或视频，自动切分识别，导出完整文本与字幕' },
      realtime: { title: '实时识别', crumb: '创建会话后边发音频边出结果，适合直播、会议等实时场景' },
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

  // ------------------------- FILE ASYNC ASR TASK LOOPS -------------------------
  const collectOverrides = () => {
    const o: { [key: string]: string } = {};
    if (ovModel.trim()) o.model = ovModel.trim();
    if (ovLanguage.trim()) o.language = ovLanguage.trim();
    if (ovSplit) o.split_strategy = ovSplit;
    if (ovChunk.trim()) o.chunk_seconds = ovChunk.trim();
    if (ovOverlap.trim()) o.overlap_seconds = ovOverlap.trim();
    if (ovHotwords.trim()) o.hotwords = ovHotwords.trim();
    if (ovHints.trim()) o.prompt_hints = ovHints.trim();
    if (ovTimestampsTouched) o.timestamps = ovTimestamps ? 'true' : 'false';
    return o;
  };

  const resetTask = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    setMediaUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setMediaIsVideo(false);
    setUploadProgress(-1);
    setSegments([]);
    setSegmentsEdited(false);
    setTaskId(null);
    setTaskStatus('—');
    setTaskTotalSegs('—');
    setTaskFinSegs(0);
    setTaskDuration('—');
    setTaskProgress(0);
    setFullText('');
    setActivePane('live');
  };

  // Seek the local media player to a segment's start time (proofreading aid).
  const handleSeek = (start: number) => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = start;
    el.play().catch(() => {});
  };

  // Inline proofreading: update a segment's text so SRT/VTT exports reflect the edit.
  const handleEditSegment = (segId: number, text: string) => {
    setSegments((prev) => prev.map((s) => (s.segment_id === segId ? { ...s, text } : s)));
    setSegmentsEdited(true);
  };

  const handleFileSelect = async (file: File) => {
    resetTask();
    setTaskStatus('uploading');
    setUploadProgress(0);

    // Keep a local object URL so the user can listen back and proofread.
    const url = URL.createObjectURL(file);
    setMediaUrl(url);
    setMediaIsVideo(file.type.startsWith('video/'));

    const fd = new FormData();
    fd.append('file', file);
    Object.entries(collectOverrides()).forEach(([k, v]) => fd.append(k, v));

    // Use XHR (not fetch) so we get real upload progress events.
    const tok = localStorage.getItem('asr_token') || '';
    try {
      const data = await new Promise<{ task_id: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open('POST', '/asr/task');
        if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          xhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { reject(new Error('返回解析失败')); }
          } else {
            reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => { xhrRef.current = null; reject(new Error('网络错误')); };
        xhr.onabort = () => { xhrRef.current = null; reject(new Error('已取消')); };
        xhr.send(fd);
      });

      setUploadProgress(-1);
      setTaskId(data.task_id);
      startTaskStream(data.task_id);
    } catch (e: any) {
      setUploadProgress(-1);
      if (e.message === '已取消') return;
      setTaskStatus('failed');
      alert('上传音频或发起切分任务失败: ' + e.message);
    }
  };

  const startTaskStream = (id: string) => {
    pollTask(id);
    
    if (esRef.current) esRef.current.close();
    
    const es = new EventSource(sseUrl(`/asr/task/${id}/stream`));
    esRef.current = es;

    const segmentHandler = (e: MessageEvent) => {
      const seg = JSON.parse(e.data);
      setSegments((prev) => {
        const nextMap = new Map(prev.map(s => [s.segment_id, s]));
        nextMap.set(seg.segment_id, seg);
        const nextList = [...nextMap.values()];
        setTaskFinSegs(nextList.filter(s => s.is_final).length);
        return nextList;
      });
    };

    const doneHandler = async () => {
      es.close();
      esRef.current = null;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      
      const infoResponse = await authedFetch(`/asr/task/${id}`);
      if (infoResponse.ok) {
        const info = await infoResponse.json();
        setTaskStatus(info.status);
        setTaskProgress(1);
      }
      
      // Fetch full transcript details
      const resultResponse = await authedFetch(`/asr/task/${id}/result`);
      if (resultResponse.ok) {
        const res = await resultResponse.json();
        setFullText(res.text || '');
        setTaskDuration(res.duration ? formatDur(res.duration) : '—');
        setActivePane('final');
      }
    };

    es.addEventListener('segment', segmentHandler);
    es.addEventListener('done', doneHandler);
    
    es.onerror = () => {
      es.close();
      esRef.current = null;
    };
  };

  const pollTask = async (id: string) => {
    if (!id) return;
    try {
      const r = await authedFetch(`/asr/task/${id}`);
      if (r.ok) {
        const info = await r.json();
        setTaskStatus(info.status);
        if (info.total_segments > 0) {
          setTaskTotalSegs(info.total_segments);
        }
        setTaskProgress(info.progress || 0);
        
        if (info.status !== 'done' && info.status !== 'failed') {
          pollTimerRef.current = setTimeout(() => pollTask(id), 1000);
        }
      }
    } catch (e) {
      pollTimerRef.current = setTimeout(() => pollTask(id), 2000);
    }
  };

  const loadHistoricalTask = async (tid: string) => {
    try {
      const r = await authedFetch(`/asr/task/${tid}/result`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = await r.json();

      // No local media for historical tasks — clear any lingering player.
      setMediaUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
      setMediaIsVideo(false);
      setSegmentsEdited(false);

      setSegments(
        (res.segments || []).map((s: any) => ({
          segment_id: s.segment_id,
          start: s.start,
          end: s.end,
          text: s.text,
          error: s.error,
          is_final: true,
          elapsed_ms: s.elapsed_ms || 0,
        }))
      );
      
      setTaskId(tid);
      setTaskTotalSegs(res.segments?.length || 0);
      setTaskFinSegs(res.segments?.length || 0);
      setTaskProgress(1);
      setTaskDuration(res.duration ? formatDur(res.duration) : '—');
      setTaskStatus(res.status);
      setFullText(res.text || '');
      
      setCurrentView('tasks');
      setViewTitle('文件转写');
      setViewCrumb('上传音频或视频，自动切分识别，导出完整文本与字幕');
    } catch (e: any) {
      alert('加载历史记录失败: ' + e.message);
    }
  };

  // Helper formats
  const formatDur = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}h${m}m` : `${m}m${sec}s`;
  };

  const STATUS_LABEL: { [k: string]: string } = {
    'uploading': '上传中', 'pending': '排队中', 'preprocessing': '预处理',
    'splitting': '切分中', 'transcribing': '识别中', 'merging': '合并中',
    'done': '已完成', 'failed': '失败', '—': '—',
  };
  const statusLabel = (s: string) => STATUS_LABEL[s] || s;
  const isReady = !!(config && config.api_key_set) || footStatus.status === 'ok';

  const downloadFile = (name: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const downloadSubtitle = async (fmt: 'srt' | 'vtt') => {
    if (!taskId) return;
    const mime = fmt === 'srt' ? 'application/x-subrip' : 'text/vtt';
    // Locally proofread? Build from edited segments. Otherwise use the backend, which
    // keeps word-level grouping and overlap de-duplication.
    if (segmentsEdited) {
      downloadFile(`${taskId}.${fmt}`, fmt === 'srt' ? buildSrt(segments) : buildVtt(segments), mime);
      return;
    }
    try {
      const r = await authedFetch(`/asr/task/${taskId}/subtitle?format=${fmt}`);
      if (!r.ok) {
        alert(`导出字幕失败: HTTP ${r.status}`);
        return;
      }
      downloadFile(`${taskId}.${fmt}`, await r.text(), mime);
    } catch (e: any) {
      alert(`网络异常: ${e.message}`);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

                  {/* Real upload progress */}
                  {uploadProgress >= 0 && (
                    <div className="mt-4">
                      <div className="flex justify-between items-center mb-1.5 text-[12px]">
                        <span className="text-fg-dim font-semibold">正在上传…</span>
                        <span className="font-mono text-accent">{uploadProgress}%</span>
                      </div>
                      <div className="bar"><div style={{ width: `${uploadProgress}%` }} /></div>
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
                        <span>Overlap seconds</span>
                        <input type="number" value={ovOverlap} onChange={e=>setOvOverlap(e.target.value)} placeholder="2" min="0" step="0.5" />
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

                      <div className="bar flex-1 min-w-[200px]">
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
                              const r = await authedFetch(`/asr/task/${taskId}/result`);
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

            {/* 3. CONFIG ROUTE */}
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

            {/* 4. HISTORY ROUTE */}
            {currentView === 'history' && (
              <motion.div
                key="history"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <HistoryView authedFetch={authedFetch} onLoadTask={loadHistoricalTask} />
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
