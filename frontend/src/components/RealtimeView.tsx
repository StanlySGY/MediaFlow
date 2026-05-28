import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Play, Square, Trash2, Mic, Terminal, Info, RefreshCw } from 'lucide-react';
import { RealtimeEvent, RealtimeSession } from '../types';

interface RealtimeViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
}

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
  const [toastClass, setToastClass] = useState<string>('text-gray-500 bg-white/2 border-white/5');
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
    setToastClass('text-yellow-400 bg-yellow-400/5 border-yellow-400/10');

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
      setToastClass('text-[#10b981] bg-[#10b981]/5 border-[#10b981]/10 drop-shadow-[0_0_10px_rgba(16,185,129,0.15)]');

      // Subscribe to SSE
      subscribeToSessionEvents(data.session_id);
    } catch (e: any) {
      setRtStatus(`✗ 创建失败: ${e.message}`);
      setToastClass('text-[#ef4444] bg-[#ef4444]/5 border-[#ef4444]/10');
      setSession(null);
    }
  };

  const subscribeToSessionEvents = (sessId: string) => {
    if (sseRef.current) sseRef.current.close();

    const es = new EventSource(sseUrl(`/asr/realtime/${sessId}/events`));
    sseRef.current = es;

    const eventTypes = ['online', 'final', 'done', 'error'];
    eventTypes.forEach(ty => {
      es.addEventListener(ty, (e: MessageEvent) => {
        const ev = JSON.parse(e.data);
        addEventLog(ty as any, ev);
        
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

  const addEventLog = (type: 'online' | 'final' | 'done' | 'error', ev: any) => {
    setRtEventCount(prev => prev + 1);
    const newEv: RealtimeEvent = {
      type,
      session_id: ev.session_id || '',
      seq: ev.seq,
      text: ev.text,
      is_final: ev.is_final,
      elapsed_ms: ev.elapsed_ms,
      error: ev.error,
    };
    setEvents(prev => [...prev, newEv]);
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
    } catch (e: any) {
      addEventLog('error', { error: `推送异常: ${e.message}` });
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
    } catch (e) {}
  };

  const handleDeleteSession = async () => {
    if (!session) return;
    if (!confirm('确认关闭并删除当前实时转写会话？')) return;

    setIsFeeding(false);
    feedingRef.current = false;
    
    try {
      await authedFetch(`/asr/realtime/${session.session_id}`, { method: 'DELETE' });
    } catch (e) {}

    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }

    setSession(null);
    setRtStatus('已删除');
    setToastClass('text-gray-500 bg-white/2 border-white/5');
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Session Create Box */}
      <div className="border border-white/5 bg-white/2 rounded-2xl p-6 backdrop-blur-md">
        <h3 className="font-title text-base font-bold text-white flex items-center gap-2 mb-4">
          <Mic className="w-5 h-5 text-[#5c54f2]" />
          <span>新建流式识别会话</span>
          <span className="text-xs text-gray-500 font-normal ml-1">Realtime ASR · base64 / SSE</span>
        </h3>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <label className="field">
            <span>Language</span>
            <input type="text" value={language} onChange={e=>setLanguage(e.target.value)} placeholder="zh / en / auto" />
          </label>
          
          <label className="field">
            <span>Sample rate (Hz)</span>
            <input type="number" value={sampleRate} onChange={e=>setSampleRate(parseInt(e.target.value, 10))} />
          </label>

          <label className="field">
            <span>Format</span>
            <input type="text" value={format} onChange={e=>setFormat(e.target.value)} />
          </label>

          <label className="field">
            <span>Channels</span>
            <input type="number" value={channels} onChange={e=>setChannels(parseInt(e.target.value, 10))} />
          </label>

          <label className="field">
            <span>Mode</span>
            <input type="text" value={mode} onChange={e=>setMode(e.target.value)} placeholder="2pass / online" />
          </label>

          <label className="field">
            <span>Hotwords</span>
            <input type="text" value={hotwords} onChange={e=>setHotwords(e.target.value)} placeholder="逗号分隔" />
          </label>
        </div>

        <div className="flex items-center gap-4 mt-6 flex-wrap">
          <button onClick={handleCreateSession} className="primary">
            <Play className="w-4 h-4" />
            <span>创建识别会话</span>
          </button>
          
          <span className={`toast ${toastClass}`}>
            {rtStatus}
          </span>
        </div>
      </div>

      {/* Active Session Dashboard */}
      {session && (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="border border-white/5 bg-white/2 rounded-2xl p-6 backdrop-blur-md"
        >
          <h3 className="font-title text-base font-bold text-white flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span>活动会话监控</span>
              <span className="font-mono text-xs text-gray-500">#{session.session_id.slice(0, 16)}…</span>
            </div>
            
            <span className="badge ok">
              <span className="dot pulse" />
              <span>Session Connected</span>
            </span>
          </h3>

          <div className="flex gap-3 mb-4">
            <span className="badge">已发送包: <b className="text-white ml-1 font-mono">{fedChunks}</b></span>
            <span className="badge">字节大小: <b className="text-white ml-1 font-mono">{fedBytes.toLocaleString()}</b> B</span>
          </div>

          {/* Glowing Bouncing Soundwave visualizer */}
          <div className={`soundwave-container ${isFeeding ? 'active' : ''}`}>
            {Array.from({ length: 12 }).map((_, idx) => (
              <div key={idx} className="bar" />
            ))}
          </div>

          {/* Interactive Chunk Feeder controls */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 p-4 rounded-xl bg-black/20 border border-white/3">
            <label className="field col-span-1 md:col-span-2">
              <span className="flex items-center gap-1">
                <Info className="w-3.5 h-3.5 text-[#5c54f2]" />
                <span>流式喂入模拟源（请选择一个本地的音频或视频文件）</span>
              </span>
              <input type="file" ref={fileInputRef} accept="audio/*,video/*" className="file:bg-[#5c54f2]/10 file:border-none file:text-[#5c54f2] file:px-4 file:py-1 file:rounded-md file:cursor-pointer" />
            </label>

            <label className="field">
              <span>分包大小 (KB)</span>
              <input type="number" value={chunkKB} onChange={e=>setChunkKB(parseInt(e.target.value,10)||1)} />
            </label>

            <label className="field">
              <span>发送毫秒间隔 (ms)</span>
              <input type="number" value={intervalMs} onChange={e=>setIntervalMs(parseInt(e.target.value,10)||0)} />
            </label>

            <label className="field col-span-1 md:col-span-2">
              <span>手动输入单包 Base64 字符串 (可选)</span>
              <div className="flex gap-2">
                <input type="text" value={manualBase64} onChange={e=>setManualBase64(e.target.value)} placeholder="粘贴 base64 音频段…" className="flex-1" />
                <button onClick={handleSendManual} className="px-4">发送单包</button>
              </div>
            </label>
          </div>

          <div className="flex items-center gap-2 mt-5 flex-wrap">
            <button onClick={handleStartFeeding} disabled={isFeeding} className="primary">
              <Play className="w-4 h-4" />
              <span>开始模拟发送</span>
            </button>
            
            <button onClick={() => { feedingRef.current = false; setIsFeeding(false); }} disabled={!isFeeding}>
              <Square className="w-4 h-4" />
              <span>停止模拟</span>
            </button>

            <button onClick={handleSendEnd} title="主动发送 Empty Chunk + is_final=true 告诉上游终止">
              发送 End 信号
            </button>

            <button onClick={handleDeleteSession} className="danger ml-auto">
              <Trash2 className="w-4 h-4" />
              <span>断开并注销会话</span>
            </button>
          </div>

          {/* SSE Logs Output Console */}
          <div className="mt-8">
            <h4 className="font-title text-sm font-bold text-white flex items-center gap-2 mb-3">
              <Terminal className="w-4 h-4 text-[#8b5cf6]" />
              <span>流式解析事件流 (EventSource)</span>
              <span className="badge text-[10px]">{rtEventCount} 个事件</span>
            </h4>
            
            <div ref={logRef} className="evlog">
              {events.length === 0 ? (
                <div className="text-gray-600 text-center py-10 font-mono text-xs">
                  [CONSOLE IDLE] 等待音频数据包流式喂入与上游事件解析通知...
                </div>
              ) : (
                events.map((ev, idx) => {
                  const ts = new Date().toLocaleTimeString();
                  const meta = [
                    ev.seq !== undefined ? `seq=${ev.seq}` : '',
                    ev.elapsed_ms !== undefined ? `${ev.elapsed_ms.toFixed(0)}ms` : '',
                  ].filter(Boolean).join(' ');

                  return (
                    <div key={idx} className="ev font-mono">
                      <span className="ts">{ts}</span>
                      <span className={`ty ${ev.type}`}>{ev.type}</span>
                      {meta && <span className="text-gray-500 text-[10px] font-semibold">[{meta}]</span>}
                      <span className="text-gray-300 ml-1">
                        {ev.error ? <span className="text-[#ef4444]">{ev.error}</span> : ev.text || '…'}
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
