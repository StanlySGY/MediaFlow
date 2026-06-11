import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Play, Square, Trash2, Mic, Terminal, Info } from 'lucide-react';
import { RealtimeEvent, RealtimeSession } from '../types';
import { errorMessage } from '../lib/errors';

interface RealtimeViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
}

// Shape of a raw SSE event payload from the realtime endpoint.
type RawRtEvent = {
  session_id?: string; seq?: number; text?: string;
  is_final?: boolean; elapsed_ms?: number; mode?: string; error?: string;
};

export const RealtimeView: React.FC<RealtimeViewProps> = ({
  authedFetch,
  sseUrl,
}) => {
  // Session Configuration Form
  const [language, setLanguage] = useState('');
  const [sampleRate, setSampleRate] = useState(16000);
  const [format, setFormat] = useState('pcm_s16le');
  const [channels, setChannels] = useState(1);
  const [mode, setMode] = useState('2pass');
  const [hotwords, setHotwords] = useState('');

  // Session State
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [rtStatus, setRtStatus] = useState<string>('未创建');
  const [toastClass, setToastClass] = useState<string>('');
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [rtEventCount, setRtEventCount] = useState(0);

  // Feeding State
  const [chunkKB, setChunkKB] = useState(8);
  const [intervalMs, setIntervalMs] = useState(100);
  const [manualBase64, setManualBase64] = useState('');
  const [isFeeding, setIsFeeding] = useState(false);
  const [fedChunks, setFedChunks] = useState(0);
  const [fedBytes, setFedBytes] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const feedingRef = useRef(false);

  // Auto-scroll the logger
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  // Clean up SSE on unmount
  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current.close();
      }
    };
  }, []);

  const handleCreateSession = async () => {
    const body = {
      language: language.trim() || null,
      sample_rate: sampleRate,
      format: format.trim() || 'pcm_s16le',
      channels,
      mode: mode.trim() || '2pass',
      hotwords: hotwords.trim() ? hotwords.trim().split(',').map(s => s.trim()).filter(Boolean) : [],
    };

    setRtStatus('创建中…');
    setToastClass('warn');

    try {
      const r = await authedFetch('/asr/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();

      setSession({
        session_id: data.session_id,
        status: 'created',
        sample_rate: sampleRate,
        format,
        channels,
        mode,
        hotwords: body.hotwords,
        chunks_received: 0,
        bytes_received: 0,
      });

      setFedChunks(0);
      setFedBytes(0);
      setRtEventCount(0);
      setEvents([]);
      
      setRtStatus(`✓ 会话 ${data.session_id.slice(0, 8)}…`);
      setToastClass('ok');

      // Subscribe to SSE
      subscribeToSessionEvents(data.session_id);
    } catch (e) {
      setRtStatus(`✗ 创建失败: ${errorMessage(e)}`);
      setToastClass('err');
      setSession(null);
    }
  };

  const subscribeToSessionEvents = (sessId: string) => {
    if (sseRef.current) sseRef.current.close();

    const es = new EventSource(sseUrl(`/asr/realtime/${sessId}/events`));
    sseRef.current = es;

    const eventTypes = ['online', 'final', 'done', 'error'] as const;
    eventTypes.forEach(ty => {
      es.addEventListener(ty, (e: MessageEvent) => {
        const ev = JSON.parse(e.data);
        addEventLog(ty, ev);
        
        if (ty === 'done' || ty === 'error') {
          es.close();
          sseRef.current = null;
          setIsFeeding(false);
          feedingRef.current = false;
        }
      });
    });

    es.onerror = () => {
      es.close();
      sseRef.current = null;
    };
  };

  const addEventLog = (type: 'online' | 'final' | 'done' | 'error', ev: RawRtEvent) => {
    setRtEventCount(prev => prev + 1);
    const newEv: RealtimeEvent = {
      type,
      session_id: ev.session_id || '',
      seq: ev.seq,
      text: ev.text,
      is_final: ev.is_final,
      elapsed_ms: ev.elapsed_ms,
      mode: ev.mode,
      error: ev.error,
    };
    setEvents(prev => [...prev, newEv]);
  };

  const handleOfflinePreset = () => {
    setFormat('wav');
    setMode('offline-simulated');
    setChunkKB(64);
    setIntervalMs(80);
    setRtStatus('已切换为 WAV 文件分包测试参数');
    setToastClass('warn');
  };

  const rtPushChunk = async (b64: string, isFinal = false) => {
    if (!session) return false;
    const seq = fedChunks + 1;
    
    try {
      const r = await authedFetch(`/asr/realtime/${session.session_id}/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seq, audio: b64, is_final: isFinal }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        addEventLog('error', { error: err.detail || `HTTP ${r.status}` });
        return false;
      }

      setFedChunks(seq);
      
      // Update session statistics
      const infoResponse = await authedFetch(`/asr/realtime/${session.session_id}`);
      if (infoResponse.ok) {
        const info = await infoResponse.json();
        setFedBytes(info.bytes_received || 0);
      }
      return true;
    } catch (e) {
      addEventLog('error', { error: `推送异常: ${errorMessage(e)}` });
      return false;
    }
  };

  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const handleStartFeeding = async () => {
    if (!session || isFeeding) return;

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      alert('请先选择需要流式发送的音频/视频文件！');
      return;
    }

    setIsFeeding(true);
    feedingRef.current = true;

    const chunkBytes = Math.max(1, chunkKB) * 1024;
    const delay = Math.max(0, intervalMs);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    
    let offset = 0;
    while (offset < buffer.length && feedingRef.current) {
      const slice = buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length));
      const b64 = bytesToBase64(slice);
      
      const success = await rtPushChunk(b64, false);
      if (!success) break;

      offset += chunkBytes;
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Send final closing segment
    if (feedingRef.current) {
      await rtPushChunk('', true);
    }

    setIsFeeding(false);
    feedingRef.current = false;
  };

  const handleSendManual = async () => {
    if (!session || !manualBase64.trim()) return;
    await rtPushChunk(manualBase64.trim(), false);
  };

  const handleSendEnd = async () => {
    if (!session) return;
    try {
      await authedFetch(`/asr/realtime/${session.session_id}/end`, { method: 'POST' });
    } catch {}
  };

  const handleDeleteSession = async () => {
    if (!session) return;
    if (!confirm('确认关闭并删除当前实时转写会话？')) return;

    setIsFeeding(false);
    feedingRef.current = false;
    
    try {
      await authedFetch(`/asr/realtime/${session.session_id}`, { method: 'DELETE' });
    } catch {}

    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }

    setSession(null);
    setRtStatus('已删除');
    setToastClass('');
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Intro hint */}
      <div className="panel p-4 flex items-start gap-3">
        <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
        <p className="hint">
          实时识别用于「边说边出字」的场景：先<b className="text-fg">创建会话</b>，再把音频按小包不断上传，服务会通过事件流实时返回识别结果。
          下方提供了一个<b className="text-fg">本地文件模拟器</b>，选一个音频文件即可体验完整流程（默认走 realtime_mock 演示数据，接真实模型请在「服务配置」里设置）。
        </p>
      </div>

      {/* Session Create Box */}
      <div className="card p-6">
        <h3 className="section-title mb-1">
          <Mic className="w-5 h-5 text-accent" />
          <span>第一步 · 创建会话</span>
        </h3>
        <p className="hint mb-4">不确定就用默认值，直接点「创建会话」即可。</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <label className="field">
            <span>识别语言</span>
            <input type="text" value={language} onChange={e=>setLanguage(e.target.value)} placeholder="zh / en / 留空自动" />
          </label>
          <label className="field">
            <span>采样率 (Hz)</span>
            <input type="number" value={sampleRate} onChange={e=>setSampleRate(parseInt(e.target.value, 10))} />
          </label>
          <label className="field">
            <span>音频格式</span>
            <input type="text" value={format} onChange={e=>setFormat(e.target.value)} />
          </label>
          <label className="field">
            <span>声道数</span>
            <input type="number" value={channels} onChange={e=>setChannels(parseInt(e.target.value, 10))} />
          </label>
          <label className="field">
            <span>识别模式</span>
            <input type="text" value={mode} onChange={e=>setMode(e.target.value)} placeholder="2pass / online" />
          </label>
          <label className="field">
            <span>热词（可选）</span>
            <input type="text" value={hotwords} onChange={e=>setHotwords(e.target.value)} placeholder="逗号分隔" />
          </label>
        </div>

        <div className="flex items-center gap-4 mt-6 flex-wrap">
          <button onClick={handleCreateSession} className="primary">
            <Play className="w-4 h-4" />
            <span>创建会话</span>
          </button>
          <button onClick={handleOfflinePreset}>
            <Info className="w-4 h-4" />
            <span>离线模拟实时测试</span>
          </button>
          <span className={`toast ${toastClass}`}>{rtStatus}</span>
        </div>
      </div>

      {/* Active Session Dashboard */}
      {session && (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="card p-6"
        >
          <h3 className="section-title justify-between mb-4">
            <div className="flex items-center gap-2">
              <span>第二步 · 发送音频并查看结果</span>
              <span className="font-mono text-xs text-muted">#{session.session_id.slice(0, 16)}…</span>
            </div>
            <span className="badge ok">
              <span className="dot pulse" />
              <span>会话进行中</span>
            </span>
          </h3>

          <div className="flex gap-3 mb-4">
            <span className="badge">已发送 <b className="text-fg ml-1 font-mono">{fedChunks}</b> 包</span>
            <span className="badge">累计 <b className="text-fg ml-1 font-mono">{fedBytes.toLocaleString()}</b> 字节</span>
          </div>

          {/* Soundwave visualizer */}
          <div className={`soundwave-container ${isFeeding ? 'active' : ''}`}>
            {Array.from({ length: 12 }).map((_, idx) => <div key={idx} className="bar" />)}
          </div>

          {/* Chunk Feeder controls */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 p-4 rounded-xl panel">
            <label className="field col-span-1 md:col-span-2">
              <span className="flex items-center gap-1">
                <Info className="w-3.5 h-3.5 text-accent" />
                <span>选择一个本地音频/视频文件用于模拟发送</span>
              </span>
              <input type="file" ref={fileInputRef} accept="audio/*,video/*"
                className="file:bg-accent-soft file:border-none file:text-accent file:px-4 file:py-1 file:rounded-md file:cursor-pointer file:mr-3" />
            </label>
            <label className="field">
              <span>每包大小 (KB)</span>
              <input type="number" value={chunkKB} onChange={e=>setChunkKB(parseInt(e.target.value,10)||1)} />
            </label>
            <label className="field">
              <span>发送间隔 (毫秒)</span>
              <input type="number" value={intervalMs} onChange={e=>setIntervalMs(parseInt(e.target.value,10)||0)} />
            </label>
            <label className="field col-span-1 md:col-span-2">
              <span>手动发送单个 Base64 数据包（高级，可选）</span>
              <div className="flex gap-2">
                <input type="text" value={manualBase64} onChange={e=>setManualBase64(e.target.value)} placeholder="粘贴 base64 音频片段…" className="flex-1" />
                <button onClick={handleSendManual} className="px-4 shrink-0">发送</button>
              </div>
            </label>
          </div>

          <div className="flex items-center gap-2 mt-5 flex-wrap">
            <button onClick={handleStartFeeding} disabled={isFeeding} className="primary">
              <Play className="w-4 h-4" />
              <span>开始发送</span>
            </button>
            <button onClick={() => { feedingRef.current = false; setIsFeeding(false); }} disabled={!isFeeding}>
              <Square className="w-4 h-4" />
              <span>停止</span>
            </button>
            <button onClick={handleSendEnd} title="发送结束信号，通知上游本次音频已结束">
              发送结束信号
            </button>
            <button onClick={handleDeleteSession} className="danger ml-auto">
              <Trash2 className="w-4 h-4" />
              <span>关闭会话</span>
            </button>
          </div>

          {/* SSE Logs Console */}
          <div className="mt-8">
            <h4 className="section-title text-sm mb-3">
              <Terminal className="w-4 h-4 text-accent-2" />
              <span>实时结果（事件流）</span>
              <span className="badge text-[10px]">{rtEventCount} 条</span>
            </h4>

            <div ref={logRef} className="evlog">
              {events.length === 0 ? (
                <div className="text-[#56627d] text-center py-10 font-mono text-xs">
                  等待音频发送，识别结果会实时显示在这里…
                </div>
              ) : (
                events.map((ev, idx) => {
                  const ts = new Date().toLocaleTimeString();
                  const meta = [
                    ev.seq !== undefined ? `seq=${ev.seq}` : '',
                    ev.mode ? ev.mode : '',
                    ev.elapsed_ms !== undefined ? `${ev.elapsed_ms.toFixed(0)}ms` : '',
                  ].filter(Boolean).join(' ');
                  const tyText = { online: '识别中', final: '最终', done: '结束', error: '错误' }[ev.type] || ev.type;
                  return (
                    <div key={idx} className="ev font-mono">
                      <span className="ts">{ts}</span>
                      <span className={`ty ${ev.type}`}>{tyText}</span>
                      {meta && <span className="text-[#56627d] text-[10px] font-semibold">[{meta}]</span>}
                      <span className="ev-text">
                        {ev.error ? <span className="text-[#ff9b96]">{ev.error}</span> : ev.text || '…'}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
};
