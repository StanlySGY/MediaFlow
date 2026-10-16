import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Download, Mic, Square, Trash2 } from 'lucide-react';
import { StandardASRStreamEvent } from '../types';
import { errorMessage, responseError } from '../lib/errors';
import { applySplice } from '../lib/splice';
import { downloadFile } from '../lib/download';

interface RealtimeRecorderPanelProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
  realtimeProvider?: string;
}

const RECORDER_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
type RealtimeRecorderState = 'idle' | 'connecting' | 'recording' | 'processing' | 'completed' | 'error';

const RECORDER_STATUS: Record<RealtimeRecorderState, string> = {
  idle: '未录音',
  connecting: '连接中…',
  recording: '录音中',
  processing: '识别中',
  completed: '识别完成',
  error: '发生错误',
};

const pickRecorderMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
};

const formatFromMime = (mimeType: string) => {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  return 'webm';
};

const blobToBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const RealtimeRecorderPanel: React.FC<RealtimeRecorderPanelProps> = ({
  authedFetch,
  sseUrl,
  realtimeProvider,
}) => {
  const [state, setState] = useState<RealtimeRecorderState>('idle');
  const isRecording = state === 'recording';
  const isBusy = state === 'connecting' || state === 'recording' || state === 'processing';
  const status = RECORDER_STATUS[state];
  const [transcript, setTranscript] = useState('');
  const [transcriptFeedback, setTranscriptFeedback] = useState('');
  const [notice, setNotice] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [chunks, setChunks] = useState(0);
  const [bytes, setBytes] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef('');
  const seqRef = useRef(0);
  const formatRef = useRef('webm');
  const pushChainRef = useRef<Promise<void>>(Promise.resolve());
  const uploadFailedRef = useRef(false);
  const generationRef = useRef(0);
  const committedTextRef = useRef('');
  const releasePromiseRef = useRef<Promise<void>>(Promise.resolve());

  const appendLog = (event: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    setLogs((prev) => [...prev.slice(-199), line]);
  };

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

  const cleanup = useCallback((expectedGeneration?: number, expectedSessionId?: string) => {
    if (
      expectedGeneration !== undefined
      && (expectedGeneration !== generationRef.current
        || (expectedSessionId && sessionIdRef.current !== expectedSessionId))
    ) return;
    uploadFailedRef.current = true;
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = '';
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    releaseSession(sessionId);
  }, [releaseSession]);

  useEffect(() => () => {
    generationRef.current += 1;
    cleanup();
  }, [cleanup]);

  const subscribe = (sessionId: string, generation: number) => {
    eventSourceRef.current?.close();
    const es = new EventSource(sseUrl(`/asr/realtime/${sessionId}/events`));
    eventSourceRef.current = es;
    let hasOpened = false;

    es.onopen = () => {
      if (
        generation !== generationRef.current
        || sessionIdRef.current !== sessionId
      ) return;
      if (hasOpened) {
        committedTextRef.current = '';
        setTranscript('');
        setTranscriptFeedback('');
      }
      hasOpened = true;
      setIsReconnecting(false);
    };

    es.addEventListener('message', (message: MessageEvent) => {
      if (
        generation !== generationRef.current
        || sessionIdRef.current !== sessionId
      ) return;
      const event = JSON.parse(message.data) as StandardASRStreamEvent;
      appendLog('sse', {
        type: event.type,
        source_event: event.source_event,
        text: event.text,
        delta: event.delta,
        is_final: event.is_final,
        elapsed_ms: event.elapsed_ms,
        error: event.error,
      });
      // Rebuild the transcript from the structured splice delta (realtime
      // `event.text` is always empty under the incremental contract).
      if (event.type === 'text' && typeof event.delta === 'object' && event.delta !== null) {
        committedTextRef.current = applySplice(committedTextRef.current, event.delta);
        setTranscript(committedTextRef.current);
      }
      if (event.type === 'done' || event.type === 'error') {
        setIsReconnecting(false);
        es.close();
        eventSourceRef.current = null;
        if (event.type === 'done') {
          setState('completed');
        } else {
          const message = event.error || '识别失败';
          setNotice(event.hint ? `${message}（${event.hint}）` : message);
          setState('error');
        }
        cleanup(generation, sessionId);
      }
    });

    es.onerror = () => {
      if (
        generation !== generationRef.current
        || sessionIdRef.current !== sessionId
      ) return;
      appendLog('sse_error', { session_id: sessionId });
      setIsReconnecting(true);
    };
  };

  const pushChunk = async (
    audio: string,
    isFinal: boolean,
    expectedSessionId?: string,
    expectedGeneration?: number,
  ) => {
    const sessionId = expectedSessionId || sessionIdRef.current;
    if (
      !sessionId
      || (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
      || sessionIdRef.current !== sessionId
    ) return false;
    const seq = seqRef.current + 1;
    seqRef.current = seq;

    const body = {
      seq,
      audio,
      is_final: isFinal,
      format: formatRef.current,
    };
    appendLog('push_audio', {
      seq,
      is_final: isFinal,
      format: formatRef.current,
      base64_chars: audio.length,
    });

    const response = await authedFetch(`/asr/realtime/${sessionId}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (
        (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
        || sessionIdRef.current !== sessionId
      ) return false;
      const err = await responseError(response);
      if (
        (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
        || sessionIdRef.current !== sessionId
      ) return false;
      appendLog('push_error', { status: response.status, message: err.message });
      setNotice(err.message);
      return false;
    }
    if (
      (expectedGeneration !== undefined && expectedGeneration !== generationRef.current)
      || sessionIdRef.current !== sessionId
    ) return false;
    setChunks(seq);

    // The audio POST already carries the running byte counter, so there is no
    // need for a second GET per chunk (that used to double the request rate).
    try {
      const data = await response.json();
      if (
        typeof data.bytes_received === 'number'
        && (expectedGeneration === undefined || expectedGeneration === generationRef.current)
        && sessionIdRef.current === sessionId
      ) {
        setBytes(data.bytes_received);
      }
    } catch {
      /* counter is cosmetic; ignore a non-JSON response */
    }
    return true;
  };

  const startRecording = async () => {
    if (isBusy) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error');
      setNotice(
        window.isSecureContext
          ? '当前浏览器不支持录音，请换用 Chrome 或 Edge'
          : '浏览器禁止在非安全页面录音。请用 https 访问，或在本机用 http://localhost 访问',
      );
      appendLog('unsupported', { secure_context: window.isSecureContext });
      return;
    }

    cleanup();
    await releasePromiseRef.current;
    setState('connecting');
    uploadFailedRef.current = false;
    setTranscript('');
    setTranscriptFeedback('');
    setNotice('');
    setIsReconnecting(false);
    committedTextRef.current = '';
    setLogs([]);
    setChunks(0);
    setBytes(0);
    seqRef.current = 0;
    pushChainRef.current = Promise.resolve();

    const mimeType = pickRecorderMimeType();
    const format = formatFromMime(mimeType);
    formatRef.current = format;
    appendLog('session_create_start', { mime_type: mimeType, format });
    let recordingSessionId = '';

    try {
      const sessionResponse = await authedFetch('/asr/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: null,
          sample_rate: 48000,
          format,
          channels: 1,
          mode: 'browser_recording',
          hotwords: [],
        }),
      });
      if (!sessionResponse.ok) throw await responseError(sessionResponse);
      const session = await sessionResponse.json();
      if (generation !== generationRef.current) {
        releaseSession(session.session_id);
        return;
      }
      recordingSessionId = session.session_id as string;
      sessionIdRef.current = recordingSessionId;
      appendLog('session_created', { session_id: recordingSessionId, format });
      subscribe(recordingSessionId, generation);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (
        generation !== generationRef.current
        || sessionIdRef.current !== recordingSessionId
      ) {
        stream.getTracks().forEach((track) => track.stop());
        if (sessionIdRef.current === recordingSessionId) {
          sessionIdRef.current = '';
          releaseSession(recordingSessionId);
        }
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (generation !== generationRef.current) return;
        if (!event.data || event.data.size === 0) return;
        const pushJob = pushChainRef.current.then(async () => {
          const audio = await blobToBase64(event.data);
          const uploaded = await pushChunk(audio, false, recordingSessionId, generation);
          if (!uploaded) throw new Error('音频分片上传失败');
        });
        const handledJob = pushJob.catch((error) => {
          if (generation !== generationRef.current || sessionIdRef.current !== recordingSessionId) return;
          uploadFailedRef.current = true;
          // This handler runs as part of the current chain. Reset the chain
          // before cleanup so releaseSession does not wait on itself.
          pushChainRef.current = Promise.resolve();
          cleanup(generation, recordingSessionId);
          setNotice(errorMessage(error));
          setState('error');
          appendLog('push_queue_error', { message: errorMessage(error) });
        });
        if (generation === generationRef.current) pushChainRef.current = handledJob;
      };
      recorder.onstop = () => {
        if (generation !== generationRef.current) return;
        if (uploadFailedRef.current) return;
        setState('processing');
        void pushChainRef.current
          .then(async () => {
            if (uploadFailedRef.current) return;
            const uploaded = await pushChunk('', true, recordingSessionId, generation);
            if (!uploaded) {
              if (generation !== generationRef.current || sessionIdRef.current !== recordingSessionId) return;
              uploadFailedRef.current = true;
              cleanup(generation, recordingSessionId);
              setNotice((prev) => prev || '结束录音失败');
              setState('error');
            }
          })
          .catch((error) => {
            if (generation !== generationRef.current || sessionIdRef.current !== recordingSessionId) return;
            uploadFailedRef.current = true;
            cleanup(generation, recordingSessionId);
            setState('error');
            appendLog('final_push_error', { message: errorMessage(error) });
          })
          .finally(() => {
            stream.getTracks().forEach((track) => track.stop());
          });
      };
      // 200ms timeslice: MediaRecorder buffers until the next tick, so a 1s
      // timeslice adds ~0.5-1s before any audio reaches the server. 200ms keeps
      // first-text latency close to the upstream partial gate, at ~5 req/s/client.
      recorder.start(200);
      setState('recording');
      appendLog('recording_started', { mime_type: recorder.mimeType || mimeType, format });
    } catch (e) {
      if (generation !== generationRef.current) return;
      if (recordingSessionId && sessionIdRef.current !== recordingSessionId) return;
      cleanup(generation);
      setState('error');
      setNotice(errorMessage(e));
      appendLog('recording_error', { message: errorMessage(e) });
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      appendLog('recording_stop');
      recorderRef.current.stop();
      if (!uploadFailedRef.current) setState('processing');
    }
  };

  const copyLogs = async () => {
    await navigator.clipboard?.writeText(logs.join('\n'));
  };

  const copyTranscript = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(transcript);
      setTranscriptFeedback('文稿已复制到剪贴板');
    } catch {
      setTranscriptFeedback('无法访问剪贴板，文稿仍保留在屏幕上');
    }
  };

  return (
    <div className="card p-6">
      <h3 className="section-title justify-between mb-4">
        <div className="flex items-center gap-2">
          <Mic className="w-5 h-5 text-accent" />
          <span>实时录音</span>
        </div>
        {realtimeProvider && (
          <span className={`badge ${realtimeProvider === 'realtime_mock' ? 'warn' : ''}`}>
            {realtimeProvider === 'realtime_mock'
              ? '演示模式：不会调用真实 ASR'
              : `实时接口：${realtimeProvider}`}
          </span>
        )}
        <span className={`badge ${isRecording ? 'warn' : transcript ? 'ok' : ''}`}>
          <span className={`dot ${isRecording ? 'pulse' : ''}`} />
          <span>{status}</span>
        </span>
      </h3>

      <div className="flex gap-2 flex-wrap mb-4">
        <button onClick={startRecording} disabled={isBusy} className="primary">
          <Mic className="w-4 h-4" />
          <span>开始录音</span>
        </button>
        <button onClick={stopRecording} disabled={!isRecording}>
          <Square className="w-4 h-4" />
          <span>停止录音</span>
        </button>
        <span className="badge">已发送 <b className="text-fg ml-1 font-mono">{chunks}</b> 包</span>
        <span className="badge">累计 <b className="text-fg ml-1 font-mono">{bytes.toLocaleString()}</b> 字节</span>
      </div>

      {notice && (
        <div className="p-3 mb-4 rounded-lg border border-err/20 bg-err-soft text-err text-[13px]">
          {notice}
        </div>
      )}
      {isReconnecting && (
        <div
          className="p-3 mb-4 rounded-lg border border-accent/20 bg-accent-soft text-accent text-[13px]"
          role="status"
          aria-live="polite"
        >
          实时结果连接中断，正在重新连接…
        </div>
      )}

      <div className="bg-white border border-border rounded-lg min-h-[260px] p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="text-[11px] text-muted font-semibold">
            {state === 'completed' ? '最终稿' : '实时文稿'}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={copyTranscript} disabled={!transcript}>
              <ClipboardCopy className="w-3.5 h-3.5" />
              <span>复制录音文稿</span>
            </button>
            <button
              onClick={() => downloadFile('realtime-recording.txt', transcript, 'text/plain;charset=utf-8')}
              disabled={!transcript}
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载录音 TXT</span>
            </button>
          </div>
        </div>
        {transcriptFeedback && (
          <p
            className="text-[12px] mb-3"
            role={transcriptFeedback.startsWith('无法访问剪贴板') ? 'alert' : 'status'}
          >
            {transcriptFeedback}
          </p>
        )}
        <div className="text-[22px] leading-relaxed text-fg whitespace-pre-wrap break-words">
          {transcript || <span className="text-muted-2">等待识别文本…</span>}
        </div>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-[12px] text-muted">调试日志</summary>
        <div className="panel p-4 min-w-0 mt-2">
          <div className="flex items-center justify-end gap-2 mb-3">
            <button onClick={copyLogs} disabled={logs.length === 0}>
              <ClipboardCopy className="w-3.5 h-3.5" />
              <span>复制日志</span>
            </button>
            <button onClick={() => setLogs([])} disabled={logs.length === 0}>
              <Trash2 className="w-3.5 h-3.5" />
              <span>清空</span>
            </button>
          </div>
          <textarea
            readOnly
            value={logs.join('\n')}
            className="w-full h-[160px] font-mono text-[11px] leading-relaxed bg-white"
            placeholder="录音、上传、SSE 事件和错误会显示在这里。"
          />
        </div>
      </details>
    </div>
  );
};
