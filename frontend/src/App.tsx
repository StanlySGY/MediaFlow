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

export default function App() {
  const { token, setToken, authedFetch, sseUrl } = useAuth();
  
  // Views Router State
  const [currentView, setCurrentView] = useState<string>('tasks');
  const [viewTitle, setViewTitle] = useState('文件转写任务');
  const [viewCrumb, setViewCrumb] = useState('上传音频/视频文件 → FFmpeg标准化格式 → 多分片异步并发ASR → 去重凭借输出完整文本与SRT/VTT字幕');

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

  const esRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<any>(null);

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
      tasks: { title: '文件转写任务', crumb: '上传音频/视频文件 → FFmpeg标准化格式 → 多分片异步并发ASR → 去重凭借输出完整文本与SRT/VTT字幕' },
      realtime: { title: '实时流式识别', crumb: '创建活跃识别会话 → 客户端音频切包 Base64 上行 → SSE流事件扇出下行 → 准实时极低延迟推送结果' },
      config: { title: '服务配置管理', crumb: '在线修改系统环境变量项 → 即时写入配置文件免重启生效 → 一键重置、上游健康连通性探查' },
      history: { title: '历史任务归档', crumb: '查询或从 outputs/ 目录加载已持久化的所有历史切分转写任务' },
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
    setSegments([]);
    setTaskId(null);
    setTaskStatus('—');
    setTaskTotalSegs('—');
    setTaskFinSegs(0);
    setTaskDuration('—');
    setTaskProgress(0);
    setFullText('');
    setActivePane('live');
  };

  const handleFileSelect = async (file: File) => {
    resetTask();
    setTaskStatus('uploading');
    
    const fd = new FormData();
    fd.append('file', file);
    
    const overrides = collectOverrides();
    Object.entries(overrides).forEach(([k, v]) => {
      fd.append(k, v);
    });

    try {
      const r = await authedFetch('/asr/task', {
        method: 'POST',
        body: fd,
      });

      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      
      setTaskId(data.task_id);
      startTaskStream(data.task_id);
    } catch (e: any) {
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
      setViewTitle('文件转写任务');
      setViewCrumb('上传音频/视频文件 → FFmpeg标准化格式 → 多分片异步并发ASR → 去重凭借输出完整文本与SRT/VTT字幕');
    } catch (e: any) {
      alert('加载归档记录失败: ' + e.message);
    }
  };

  // Helper formats
  const formatDur = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}h${m}m` : `${m}m${sec}s`;
  };

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
    try {
      const r = await authedFetch(`/asr/task/${taskId}/subtitle?format=${fmt}`);
      if (!r.ok) {
        alert(`导出字幕失败: HTTP ${r.status}`);
        return;
      }
      const text = await r.text();
      downloadFile(
        `${taskId}.${fmt}`,
        text,
        fmt === 'srt' ? 'application/x-subrip' : 'text/vtt'
      );
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
      {/* Sidebar navigation */}
      <Sidebar
        currentView={currentView}
        onViewChange={handleViewChange}
        config={config}
        footStatus={footStatus}
      />

      {/* Main dashboard body */}
      <main className="main flex-1 flex flex-col min-w-0">
        <Header
          title={viewTitle}
          crumb={viewCrumb}
          config={config}
          onSetToken={handleSetToken}
        />

        <div className="content p-8 max-w-7xl w-full mx-auto flex-1">
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
                {/* Upload drag drop panel */}
                <div className="border border-white/5 bg-white/2 rounded-2xl p-6 backdrop-blur-md">
                  <Dropzone onFileSelect={handleFileSelect} disabled={taskStatus === 'uploading' || taskStatus === 'processing'} />
                  
                  {/* Parameter Accordion Overrides */}
                  <Accordion title="⚙ 仅对本次转写任务覆盖选项 (参数留空将使用服务器默认值)">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5">
                      <label className="field">
                        <span>Model</span>
                        <input type="text" value={ovModel} onChange={e=>setOvModel(e.target.value)} placeholder="qwen3-asr-flash" />
                      </label>
                      <label className="field">
                        <span>Language</span>
                        <input type="text" value={ovLanguage} onChange={e=>setOvLanguage(e.target.value)} placeholder="zh / en / auto" />
                      </label>
                      <label className="field">
                        <span>Split strategy</span>
                        <select value={ovSplit} onChange={e=>setOvSplit(e.target.value)}>
                          <option value="">(默认)</option>
                          <option value="fixed">fixed</option>
                          <option value="silence">silence</option>
                          <option value="overlap">overlap</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Chunk seconds</span>
                        <input type="number" value={ovChunk} onChange={e=>setOvChunk(e.target.value)} placeholder="30" min="5" step="5" />
                      </label>
                      <label className="field">
                        <span>Overlap seconds</span>
                        <input type="number" value={ovOverlap} onChange={e=>setOvOverlap(e.target.value)} placeholder="2" min="0" step="0.5" />
                      </label>
                      <label className="field">
                        <span>Hotwords</span>
                        <input type="text" value={ovHotwords} onChange={e=>setOvHotwords(e.target.value)} placeholder="逗号分隔" />
                      </label>
                      <label className="field">
                        <span>Prompt hints</span>
                        <input type="text" value={ovHints} onChange={e=>setOvHints(e.target.value)} placeholder="自由文本上下文提示" />
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
                        <span>请求 Word 级别时间戳</span>
                      </label>
                    </div>
                  </Accordion>
                </div>

                {/* Active progress tracking cards panel */}
                {taskId && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="border border-white/5 bg-white/2 rounded-2xl p-6 backdrop-blur-md"
                  >
                    <h3 className="font-title text-base font-bold text-white flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <span>任务转写中</span>
                        <span className="font-mono text-xs text-gray-500">#{taskId.slice(0, 16)}…</span>
                      </div>
                      
                      <span className={`badge ${taskStatus === 'done' ? 'ok' : taskStatus === 'failed' ? 'err' : 'warn'}`}>
                        <span className="dot pulse" />
                        <span>{taskStatus}</span>
                      </span>
                    </h3>

                    {/* Stats details bar */}
                    <div className="row gap-4 mb-6 items-center flex-wrap">
                      <span className="badge">分片切分: <b className="text-white ml-1 font-mono">{taskFinSegs}/{taskTotalSegs}</b></span>
                      <span className="badge">时长总计: <b className="text-white ml-1 font-mono">{taskDuration}</b></span>
                      
                      <div className="bar flex-1 min-w-[200px]">
                        <div style={{ width: `${taskProgress * 100}%` }} />
                      </div>

                      <button onClick={resetTask}>
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>释放面板</span>
                      </button>
                    </div>

                    {/* Segmented pane controllers */}
                    <div className="tabs-container">
                      <div 
                        onClick={() => setActivePane('live')} 
                        className={`tab ${activePane === 'live' ? 'active' : ''}`}
                      >
                        实时分片 ({segments.length})
                      </div>
                      
                      <div 
                        onClick={() => setActivePane('final')} 
                        className={`tab ${activePane === 'final' ? 'active' : ''}`}
                      >
                        完整合并文本
                      </div>
                    </div>

                    {/* Sub-panels display */}
                    <div className="mt-4">
                      {activePane === 'live' ? (
                        <div className="pane">
                          <SegmentList segments={segments} taskId={taskId} authedFetch={authedFetch} />
                          {segments.length === 0 && (
                            <div className="empty flex flex-col items-center justify-center py-14">
                              <span className="ico text-3xl animate-bounce">⌛</span>
                              <p className="text-gray-500 text-xs font-mono mt-3">
                                等待 FFmpeg 预分切与流式并发接收通知...
                              </p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="pane flex flex-col gap-4">
                          <textarea
                            value={fullText}
                            readOnly
                            placeholder="音频流拼接中，完成后在此显示全部识别内容…"
                            className="w-full min-h-[300px] border border-white/5 bg-black/20 p-5 rounded-xl font-mono text-sm leading-relaxed text-gray-200"
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
