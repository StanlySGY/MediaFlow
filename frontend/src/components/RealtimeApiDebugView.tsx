import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Play, Square, Trash2, Mic, Terminal, Info, ClipboardCopy, Download } from 'lucide-react';
import { RealtimeEvent, RealtimeSession, StandardASRStreamEvent } from '../types';
import { errorMessage, responseError } from '../lib/errors';
import { applySplice } from '../lib/splice';
import { downloadFile } from '../lib/download';
import { base64Bytes, formatSize } from '../lib/uploadPreflight';
import { Accordion } from './Accordion';
import { useConfirmDialog } from './ConfirmDialog';


interface RealtimeApiDebugViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
  /** Per-chunk / per-session audio caps from GET /asr/config. Feeding past the
   *  chunk cap is a 413 per package, and past the session cap it is a 413 partway
   *  through a long feed, so both are worth stating before the first package. */
  maxChunkBytes?: number;
  maxSessionBytes?: number;
  maxSessionSeconds?: number;
}

/**
 * 接口调试：手动建会话、按包推音频、看原始事件流。
 *
 * 这套流程原先嵌在「实时识别」页的一个折叠面板里，但它回答的问题和录音不是
 * 同一个：录音是用户要完成的事，这里是验证服务端接口本身——包大小、会话上限、
 * 事件顺序、provider 是否可达。拆成独立视图之后，实时识别页只剩录音这一条产品
 * 路径，调试路径也不再把两组互不相干的状态绑在同一个组件里。
 */
export const RealtimeApiDebugView: React.FC<RealtimeApiDebugViewProps> = ({
  authedFetch,
  sseUrl,
  maxChunkBytes,
  maxSessionBytes,
  maxSessionSeconds,
}) => {

type LocalRtEvent = Partial<StandardASRStreamEvent> & {
  mode?: string;
  source_event?: string | null;
};

const closeEventSource = (source: EventSource | null) => {
  source?.close();
};

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
  // Inline feed error channel (replaces alert on the missing-file guard).
  const [feedError, setFeedError] = useState<string | null>(null);
  const { confirm: confirmDialog, dialog: confirmElement } = useConfirmDialog();
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [rtEventCount, setRtEventCount] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [transcriptFeedback, setTranscriptFeedback] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);

  // Feeding State
  const [chunkKB, setChunkKB] = useState(8);
  const [intervalMs, setIntervalMs] = useState(100);
  const [manualBase64, setManualBase64] = useState('');
  const [isFeeding, setIsFeeding] = useState(false);
  const [fedChunks, setFedChunks] = useState(0);
  const [fedBytes, setFedBytes] = useState(0);
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const feedingRef = useRef(false);
  const committedTextRef = useRef('');
  const sessionIdRef = useRef('');
  const generationRef = useRef(0);
  const fedChunksRef = useRef(0);
  const releasePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const pushChainRef = useRef<Promise<void>>(Promise.resolve());
  const creatingSessionRef = useRef(false);

  const releaseSession = useCallback((sessionId: string) => {
    if (!sessionId) return Promise.resolve();
    const pendingPushes = pushChainRef.current;
    const release = releasePromiseRef.current
      .then(() => pendingPushes)
      .then(() => authedFetch(`/asr/realtime/${sessionId}`, { method: 'DELETE' }))
      .then(() => undefined)
      .catch(() => undefined);
    releasePromiseRef.current = release;
    return release;
  }, [authedFetch]);

  // Auto-scroll the logger
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  // Clean up SSE on unmount
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      if (sseRef.current) {
        sseRef.current.close();
      }
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = '';
      releaseSession(sessionId);
    };
  }, [releaseSession]);

  const handleCreateSession = async () => {
    if (creatingSessionRef.current) return;
    creatingSessionRef.current = true;
    setIsCreatingSession(true);
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const previousSessionId = sessionIdRef.current;
    sessionIdRef.current = '';
    feedingRef.current = false;
    setIsFeeding(false);
    setSession(null);
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    releaseSession(previousSessionId);
    await releasePromiseRef.current;
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

      if (!r.ok) throw await responseError(r);
      const data = await r.json();
      if (generation !== generationRef.current) {
        releaseSession(data.session_id);
        return;
      }
      sessionIdRef.current = data.session_id;

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
      fedChunksRef.current = 0;
      pushChainRef.current = Promise.resolve();
      setFedBytes(0);
      setRtEventCount(0);
      setEvents([]);
      committedTextRef.current = '';
      setTranscript('');
      setTranscriptFeedback('');
      setIsReconnecting(false);
      
      setRtStatus(`✓ 会话 ${data.session_id.slice(0, 8)}…`);
      setToastClass('ok');

      // Subscribe to SSE
      subscribeToSessionEvents(data.session_id, generation);
    } catch (e) {
      if (generation !== generationRef.current) return;
      const failedSessionId = sessionIdRef.current;
      sessionIdRef.current = '';
      const failedEventSource = sseRef.current;
      sseRef.current = null;
      closeEventSource(failedEventSource);
      releaseSession(failedSessionId);
      setRtStatus(`✗ 创建失败: ${errorMessage(e)}`);
      setToastClass('err');
      setSession(null);
    } finally {
      creatingSessionRef.current = false;
      setIsCreatingSession(false);
    }
  };

  const subscribeToSessionEvents = (sessId: string, generation: number) => {
    if (sseRef.current) sseRef.current.close();

    const es = new EventSource(sseUrl(`/asr/realtime/${sessId}/events`));
    sseRef.current = es;
    let hasOpened = false;

    es.onopen = () => {
      if (generation !== generationRef.current || sessionIdRef.current !== sessId) return;
      // EventSource reconnects by itself, and the server rebuilds the delta
      // chain from an empty baseline for every new connection (previous_text is
      // per-connection in stream_realtime_session; there is no Last-Event-ID
      // resume), so the replayed events only line up against a cleared local
      // transcript — removing this reset would double-apply the replay.
      if (hasOpened) {
        committedTextRef.current = '';
        setTranscript('');
        setTranscriptFeedback('');
        setEvents([]);
        setRtEventCount(0);
      }
      hasOpened = true;
      setIsReconnecting(false);
    };

    es.addEventListener('message', (e: MessageEvent) => {
      if (generation !== generationRef.current || sessionIdRef.current !== sessId) return;
      const ev = JSON.parse(e.data) as StandardASRStreamEvent;
      if (ev.stream !== 'realtime') return;
      addEventLog(ev);

      if (ev.type === 'done' || ev.type === 'error') {
        setIsReconnecting(false);
        es.close();
        sseRef.current = null;
        setIsFeeding(false);
        feedingRef.current = false;
        setSession(prev => prev ? {
          ...prev,
          status: ev.type === 'done' ? 'done' : 'failed',
        } : prev);
        if (sessionIdRef.current === sessId) {
          sessionIdRef.current = '';
          releaseSession(sessId);
        }
      }
    });

    es.onerror = () => {
      if (generation !== generationRef.current || sessionIdRef.current !== sessId) return;
      setIsReconnecting(true);
    };
  };

  const addEventLog = (ev: LocalRtEvent) => {
    setRtEventCount(prev => prev + 1);
    const type: RealtimeEvent['type'] =
      ev.type === 'text'
        ? (ev.source_event === 'final' ? 'final' : 'online')
        : ev.type === 'done'
          ? 'done'
          : 'error';

    // Rebuild the committed transcript from the structured splice delta
    // (realtime `ev.text` is always empty under the incremental contract).
    let text = ev.text;
    if (ev.type === 'text' && typeof ev.delta === 'object' && ev.delta !== null) {
      committedTextRef.current = applySplice(committedTextRef.current, ev.delta);
      text = committedTextRef.current;
      setTranscript(committedTextRef.current);
    }

    const newEv: RealtimeEvent = {
      type,
      session_id: ev.session_id || ev.id || '',
      seq: ev.seq ?? undefined,
      text,
      delta: ev.delta,
      is_final: ev.is_final ?? undefined,
      elapsed_ms: ev.elapsed_ms ?? undefined,
      mode: ev.mode,
      error: ev.error || undefined,
      raw: ev,
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

  const rtPushChunk = (
    b64: string,
    isFinal = false,
    expectedSessionId?: string,
    expectedGeneration?: number,
  ) => {
    const pushJob = pushChainRef.current.then(async () => {
      const sessionId = expectedSessionId || sessionIdRef.current;
      if (
        !session
        || !sessionId
        || session.session_id !== sessionId
        || sessionIdRef.current !== sessionId
        || (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
      ) return false;
      const seq = fedChunksRef.current + 1;

      try {
        const r = await authedFetch(`/asr/realtime/${sessionId}/audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seq, audio: b64, is_final: isFinal }),
        });

        if (!r.ok) {
          if (
            sessionIdRef.current !== sessionId
            || (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
          ) return false;
          const err = await r.json().catch(() => ({}));
          addEventLog({
            type: 'error',
            stream: 'realtime',
            id: sessionId,
            session_id: sessionId,
            error: err.detail || `HTTP ${r.status}`,
          });
          return false;
        }

        if (
          sessionIdRef.current !== sessionId
          || (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
        ) return false;
        fedChunksRef.current = seq;
        setFedChunks(seq);

        // The push response already carries the running totals — the route is
        // documented as returning them precisely to save a status round-trip per
        // chunk, which at 10 chunks/second is the bulk of the request load.
        try {
          const info = await r.json();
          if (
            sessionIdRef.current === sessionId
            && (expectedGeneration === undefined || expectedGeneration === generationRef.current)
          ) setFedBytes(info.bytes_received || 0);
        } catch {
          // The chunk was accepted; only the byte counter is lost.
        }
        return true;
      } catch (e) {
        if (
          sessionIdRef.current !== sessionId
          || (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
        ) return false;
        addEventLog({
          type: 'error',
          stream: 'realtime',
          id: sessionId,
          session_id: sessionId,
          error: `推送异常: ${errorMessage(e)}`,
        });
        return false;
      }
    });
    pushChainRef.current = pushJob.then(() => undefined, () => undefined);
    return pushJob;
  };

  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const handleStartFeeding = async () => {
    if (!session || !sessionIdRef.current || isFeeding || !sessionActive) return;

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setFeedError('请先在上方的文件选择器里选择一个要流式发送的音频/视频文件。');
      return;
    }
    setFeedError(null);

    setIsFeeding(true);
    feedingRef.current = true;
    const feedingSessionId = session.session_id;
    const feedingGeneration = generationRef.current;

    let chunkBytes = Math.max(1, chunkKB) * 1024;
    if (maxChunkBytes && chunkBytes > maxChunkBytes) {
      setFeedError(
        `每包 ${formatSize(chunkBytes)} 超过服务端单包上限 ${formatSize(maxChunkBytes)}。` +
        '已按上限重新计算包大小，无需手动调整。',
      );
      chunkBytes = maxChunkBytes;
      setChunkKB(Math.floor(maxChunkBytes / 1024));
    }
    if (maxSessionBytes && file.size > maxSessionBytes) {
      setFeedError(
        `这个文件 ${formatSize(file.size)} 超过服务端单会话音频上限 ${formatSize(maxSessionBytes)}，` +
        '发到一半会被拒绝。请只发送其中的一段。',
      );
      return;
    }
    const delay = Math.max(0, intervalMs);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    let offset = 0;
    while (
      offset < buffer.length
      && feedingRef.current
      && feedingGeneration === generationRef.current
      && sessionIdRef.current === feedingSessionId
    ) {
      const slice = buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length));
      const b64 = bytesToBase64(slice);
      
      const success = await rtPushChunk(b64, false, feedingSessionId, feedingGeneration);
      if (!success) break;

      offset += chunkBytes;
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Send final closing segment
    if (
      feedingRef.current
      && feedingGeneration === generationRef.current
      && sessionIdRef.current === feedingSessionId
    ) {
      await rtPushChunk('', true, feedingSessionId, feedingGeneration);
    }

    if (feedingGeneration === generationRef.current && sessionIdRef.current === feedingSessionId) {
      setIsFeeding(false);
      feedingRef.current = false;
    }
  };

  const handleSendManual = async () => {
    if (!session || !manualBase64.trim()) return;
    const payload = manualBase64.trim();
    if (maxChunkBytes && base64Bytes(payload) > maxChunkBytes) {
      setFeedError(
        `这段 base64 解码后是 ${formatSize(base64Bytes(payload))}，超过服务端单包上限 ` +
        `${formatSize(maxChunkBytes)}，上游会直接拒收。`,
      );
      return;
    }
    await rtPushChunk(payload, false, session.session_id, generationRef.current);
  };

  const copyTranscript = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(transcript);
      setTranscriptFeedback('会话文稿已复制到剪贴板');
    } catch {
      setTranscriptFeedback('无法访问剪贴板，会话文稿仍保留在屏幕上');
    }
  };

  const handleSendEnd = async () => {
    if (!session || !sessionIdRef.current) return;
    const endSessionId = session.session_id;
    const endGeneration = generationRef.current;
    feedingRef.current = false;
    setIsFeeding(false);
    const endJob = pushChainRef.current.then(async () => {
      if (
        endGeneration !== generationRef.current
        || sessionIdRef.current !== endSessionId
      ) return;
      try {
        const response = await authedFetch(`/asr/realtime/${endSessionId}/end`, { method: 'POST' });
        if (!response.ok) {
          const error = await responseError(response);
          if (
            endGeneration === generationRef.current
            && sessionIdRef.current === endSessionId
          ) addEventLog({
            type: 'error',
            stream: 'realtime',
            id: endSessionId,
            session_id: endSessionId,
            error: error.message,
          });
        }
      } catch (error) {
        if (
          endGeneration === generationRef.current
          && sessionIdRef.current === endSessionId
        ) addEventLog({
          type: 'error',
          stream: 'realtime',
          id: endSessionId,
          session_id: endSessionId,
          error: `结束会话异常: ${errorMessage(error)}`,
        });
      }
    });
    pushChainRef.current = endJob.then(() => undefined, () => undefined);
    await endJob;
  };

  const handleDeleteSession = async () => {
    if (!session) return;
    const ok = await confirmDialog({
      title: '关闭并删除会话？',
      message: (
        <>
          会话 <code className="font-mono">#{session.session_id.slice(0, 16)}…</code> 会立即停止接收音频，
          上游会话资源被释放，未发送完的音频不会再有结果。屏幕上已识别出的文稿不会因为关闭而消失，
          但关闭后无法继续向同一会话追加音频。
        </>
      ),
      confirmLabel: '关闭会话',
    });
    if (!ok) return;

    const sessionId = session.session_id;
    const deleteGeneration = generationRef.current + 1;
    generationRef.current = deleteGeneration;
    setIsFeeding(false);
    feedingRef.current = false;
    sessionIdRef.current = '';
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }

    const release = releaseSession(sessionId);
    await release;
    if (deleteGeneration !== generationRef.current) return;

    setSession(null);
    setRtStatus('已删除');
    setToastClass('');
  };

  const sessionActive = session ? !['done', 'failed', 'closed'].includes(session.status) : false;

  // The dialog is mounted outside the accordion: 关闭会话 lives inside the
  // panel, and a confirmation asked from a collapsed panel would be invisible.
  return (
    <>
      {confirmElement}
      <Accordion title="接口会话 · 手动建会话、文件模拟、事件流">
        {/* Intro hint */}
        <div className="panel px-4 py-3 flex items-start gap-2.5">
          <Info className="w-3.5 h-3.5 text-muted-2 shrink-0 mt-0.5" />
          <p className="hint">
            先创建会话，再把音频按小包上传，服务通过事件流实时返回识别结果。下方的文件模拟器可以选一段音频体验完整流程。
          </p>
        </div>

        {/* Session Create Box */}
        <div className="card p-6">
          <h3 className="section-title mb-1">
            <Mic className="w-4 h-4 text-muted" />
            <span>创建会话</span>
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
            <button onClick={handleCreateSession} disabled={isCreatingSession} className="primary">
              <Play className="w-4 h-4" />
              <span>{isCreatingSession ? '创建中…' : '创建会话'}</span>
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
            className="card p-4 sm:p-6"
          >
            <h3 className="section-title justify-between mb-4">
              <div className="flex items-center gap-2 min-w-0">
                <span>发送音频</span>
                <span className="font-mono text-meta font-normal text-muted-2 truncate">
                  #{session.session_id.slice(0, 16)}…
                </span>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 text-sm font-medium ${
                  sessionActive || session.status === 'done' ? 'text-ok' : 'text-err'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    sessionActive || session.status === 'done' ? 'bg-ok' : 'bg-err'
                  }`}
                />
                {sessionActive ? '进行中' : session.status === 'done' ? '识别完成' : '已结束'}
              </span>
            </h3>

            {isReconnecting && (
              <div
                className="p-3 mb-4 rounded-lg border border-accent/20 bg-accent-soft text-accent text-[13px]"
                role="status"
                aria-live="polite"
              >
                事件流连接中断，正在重新连接…
              </div>
            )}

            <div className="text-sm text-muted tabular-nums mb-4">
              已发送 <b className="text-fg font-medium">{fedChunks}</b> 包 ·
              累计 <b className="text-fg font-medium">{formatSize(fedBytes)}</b>
            </div>

            {/* Soundwave visualizer */}
            <div className={`soundwave-container ${isFeeding ? 'active' : ''}`}>
              {Array.from({ length: 12 }).map((_, idx) => <div key={idx} className="bar" />)}
            </div>

            {/* Chunk Feeder controls */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6 p-4 rounded-lg panel">
              <label className="field col-span-1 md:col-span-2">
                <span className="flex items-center gap-1">
                  <Info className="w-3.5 h-3.5 text-accent" />
                  <span>选择一个本地音频/视频文件用于模拟发送</span>
                </span>
                <input type="file" ref={fileInputRef} accept="audio/*,video/*" />
              </label>
              <label className="field">
                <span>每包大小 (KB){maxChunkBytes ? <>，上限 {formatSize(maxChunkBytes)}</> : null}</span>
                <input
                  type="number"
                  min={1}
                  max={maxChunkBytes ? Math.floor(maxChunkBytes / 1024) : undefined}
                  value={chunkKB}
                  onChange={e=>setChunkKB(parseInt(e.target.value,10)||1)}
                />
              </label>
              <label className="field">
                <span>发送间隔 (毫秒)</span>
                <input type="number" value={intervalMs} onChange={e=>setIntervalMs(parseInt(e.target.value,10)||0)} />
              </label>
              {(maxSessionBytes || maxSessionSeconds) && (
                <p className="col-span-1 md:col-span-2 text-meta text-muted">
                  服务端单个实时会话最多接收
                  {maxSessionBytes ? <> {formatSize(maxSessionBytes)} 音频</> : null}
                  {maxSessionBytes && maxSessionSeconds ? '、' : null}
                  {maxSessionSeconds ? <> 连续 {Math.round(maxSessionSeconds / 60)} 分钟</> : null}
                  ；超出后上游会拒收，需要新建会话继续。
                </p>
              )}
              <label className="field col-span-1 md:col-span-2">
                <span>手动发送单个 Base64 数据包（高级，可选）</span>
                <div className="flex gap-2">
                  <input type="text" value={manualBase64} onChange={e=>setManualBase64(e.target.value)} placeholder="粘贴 base64 音频片段…" className="flex-1" />
                  <button onClick={handleSendManual} className="px-4 shrink-0">发送</button>
                </div>
              </label>
            </div>

            {feedError && (
              <div role="alert" className="flex items-center gap-2.5 rounded-[10px] border border-err/30 bg-err-soft px-4 py-3 mt-5 text-sm text-err">
                <span className="font-medium">{feedError}</span>
                <span className="flex-1" />
                <button onClick={() => setFeedError(null)} aria-label="关闭提示" className="ghost w-7 h-7 p-0">忽略</button>
              </div>
            )}

            <div className="flex items-center gap-2 mt-5 flex-wrap">
              <button onClick={handleStartFeeding} disabled={isFeeding || !sessionActive} className="primary">
                <Play className="w-4 h-4" />
                <span>开始发送</span>
              </button>
              <button onClick={() => { feedingRef.current = false; setIsFeeding(false); }} disabled={!isFeeding}>
                <Square className="w-4 h-4" />
                <span>停止</span>
              </button>
              <button onClick={handleSendEnd} disabled={!sessionActive} title="发送结束信号，通知上游本次音频已结束">
                发送结束信号
              </button>
              {/* Named for the state it acts on: the trigger asks for
                  confirmation, the confirmation performs the close. */}
              <button
                onClick={handleDeleteSession}
                className="danger ml-auto"
                disabled={!sessionActive}
                aria-label="关闭当前会话"
              >
                <Trash2 className="w-4 h-4" />
                <span>关闭会话</span>
              </button>
            </div>

            {/* SSE Logs Console */}
            <div className="mt-8">
              <h4 className="section-title text-sm mb-3">
                <Terminal className="w-4 h-4 text-muted" />
                <span>实时结果（事件流）</span>
                <span className="text-meta font-normal text-muted-2">{rtEventCount} 条</span>
              </h4>

              <div className="flex items-center gap-2 flex-wrap mb-3">
                <button onClick={copyTranscript} disabled={!transcript}>
                  <ClipboardCopy className="w-3.5 h-3.5" />
                  <span>复制会话文稿</span>
                </button>
                <button
                  onClick={() => downloadFile('realtime-session.txt', transcript, 'text/plain;charset=utf-8')}
                  disabled={!transcript}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下载会话 TXT</span>
                </button>
                {transcriptFeedback && (
                  <p
                    className="text-[12px]"
                    role={transcriptFeedback.startsWith('无法访问剪贴板') ? 'alert' : 'status'}
                  >
                    {transcriptFeedback}
                  </p>
                )}
              </div>

              <div ref={logRef} className="evlog">
                {events.length === 0 ? (
                  <div className="text-console-muted text-center py-10 font-mono text-xs">
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
                        {meta && <span className="text-console-muted text-[10px] font-semibold">[{meta}]</span>}
                        <span className="ev-text">
                          {ev.error ? <span className="text-console-err">{ev.error}</span> : ev.text || '…'}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </motion.div>
        )}
      </Accordion>
    </>
  );
};
