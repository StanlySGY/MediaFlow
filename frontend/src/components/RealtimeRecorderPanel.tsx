import React, { useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Mic, Square, Trash2 } from 'lucide-react';
import { StandardASRStreamEvent } from '../types';
import { errorMessage, responseError } from '../lib/errors';
import { applySplice } from '../lib/splice';

interface RealtimeRecorderPanelProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
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
}) => {
  const [state, setState] = useState<RealtimeRecorderState>('idle');
  const isRecording = state === 'recording';
  const isBusy = state === 'connecting' || state === 'recording' || state === 'processing';
  const status = RECORDER_STATUS[state];
  const [transcript, setTranscript] = useState('');
  const [notice, setNotice] = useState('');
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

  const appendLog = (event: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    setLogs((prev) => [...prev.slice(-199), line]);
  };

  const cleanup = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  };

  useEffect(() => () => cleanup(), []);

  const subscribe = (sessionId: string, generation: number) => {
    eventSourceRef.current?.close();
    const es = new EventSource(sseUrl(`/asr/realtime/${sessionId}/events`));
    eventSourceRef.current = es;

    es.addEventListener('message', (message: MessageEvent) => {
      if (generation !== generationRef.current) return;
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
        es.close();
        eventSourceRef.current = null;
        if (event.type === 'done') {
          setState('completed');
        } else {
          const message = event.error || '识别失败';
          setNotice(event.hint ? `${message}（${event.hint}）` : message);
          setState('error');
        }
      }
    });

    es.onerror = () => {
      if (generation !== generationRef.current) return;
      appendLog('sse_error', { session_id: sessionId });
      es.close();
      eventSourceRef.current = null;
      setNotice('实时结果连接中断，请重试');
      setState('error');
    };
  };

  const pushChunk = async (audio: string, isFinal: boolean) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return false;
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
      const err = await responseError(response);
      appendLog('push_error', { status: response.status, message: err.message });
      setNotice(err.message);
      return false;
    }
    setChunks(seq);

    // The audio POST already carries the running byte counter, so there is no
    // need for a second GET per chunk (that used to double the request rate).
    try {
      const data = await response.json();
      if (typeof data.bytes_received === 'number') {
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
    setState('connecting');
    uploadFailedRef.current = false;
    setTranscript('');
    setNotice('');
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
      sessionIdRef.current = session.session_id;
      appendLog('session_created', { session_id: session.session_id, format });
      subscribe(session.session_id, generation);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (generation !== generationRef.current) return;
        if (!event.data || event.data.size === 0) return;
        const pushJob = pushChainRef.current.then(async () => {
          const audio = await blobToBase64(event.data);
          const uploaded = await pushChunk(audio, false);
          if (!uploaded) throw new Error('音频分片上传失败');
        });
        pushChainRef.current = pushJob.catch((error) => {
          uploadFailedRef.current = true;
          setNotice(errorMessage(error));
          setState('error');
          appendLog('push_queue_error', { message: errorMessage(error) });
        });
      };
      recorder.onstop = () => {
        if (generation !== generationRef.current) return;
        setState('processing');
        void pushChainRef.current
          .then(async () => {
            if (uploadFailedRef.current) return;
            const uploaded = await pushChunk('', true);
            if (!uploaded) {
              uploadFailedRef.current = true;
              setNotice((prev) => prev || '结束录音失败');
              setState('error');
            }
          })
          .catch((error) => {
            uploadFailedRef.current = true;
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
      cleanup();
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

  return (
    <div className="card p-6">
      <h3 className="section-title justify-between mb-4">
        <div className="flex items-center gap-2">
          <Mic className="w-5 h-5 text-accent" />
          <span>实时录音</span>
        </div>
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
        <div className="p-3 mb-4 rounded-xl border border-err/20 bg-err-soft text-err text-[13px]">
          {notice}
        </div>
      )}

      <div className="bg-white border border-border rounded-xl min-h-[260px] p-6">
        <div className="text-[11px] text-muted font-semibold mb-3">
          {state === 'completed' ? '最终稿' : '实时文稿'}
        </div>
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
