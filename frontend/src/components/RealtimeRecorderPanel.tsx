import React, { useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Mic, Square, Trash2 } from 'lucide-react';
import { StandardASRStreamEvent } from '../types';
import { errorMessage } from '../lib/errors';

interface RealtimeRecorderPanelProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
}

const RECORDER_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];

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
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('未录音');
  const [transcript, setTranscript] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [chunks, setChunks] = useState(0);
  const [bytes, setBytes] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef('');
  const seqRef = useRef(0);
  const formatRef = useRef('webm');
  const pendingPushesRef = useRef<Promise<unknown>[]>([]);

  useEffect(() => () => cleanup(), []);

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

  const subscribe = (sessionId: string) => {
    eventSourceRef.current?.close();
    const es = new EventSource(sseUrl(`/asr/realtime/${sessionId}/events`));
    eventSourceRef.current = es;

    es.addEventListener('message', (message: MessageEvent) => {
      const event = JSON.parse(message.data) as StandardASRStreamEvent;
      appendLog('sse', {
        type: event.type,
        source_event: event.source_event,
        text: event.text,
        is_final: event.is_final,
        elapsed_ms: event.elapsed_ms,
        error: event.error,
      });
      if (event.text) setTranscript(event.text);
      if (event.type === 'done' || event.type === 'error') {
        es.close();
        eventSourceRef.current = null;
        setIsRecording(false);
      }
    });

    es.onerror = () => {
      appendLog('sse_error', { session_id: sessionId });
      es.close();
      eventSourceRef.current = null;
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
      appendLog('push_error', { status: response.status, body: await response.text() });
      return false;
    }
    setChunks(seq);

    const info = await authedFetch(`/asr/realtime/${sessionId}`);
    if (info.ok) {
      const data = await info.json();
      setBytes(data.bytes_received || 0);
    }
    return true;
  };

  const startRecording = async () => {
    if (isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus('当前浏览器不支持录音');
      appendLog('unsupported');
      return;
    }

    cleanup();
    setTranscript('');
    setLogs([]);
    setChunks(0);
    setBytes(0);
    seqRef.current = 0;
    pendingPushesRef.current = [];

    const mimeType = pickRecorderMimeType();
    const format = formatFromMime(mimeType);
    formatRef.current = format;
    setStatus('创建会话中…');
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
      if (!sessionResponse.ok) throw new Error(await sessionResponse.text());
      const session = await sessionResponse.json();
      sessionIdRef.current = session.session_id;
      appendLog('session_created', { session_id: session.session_id, format });
      subscribe(session.session_id);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = async (event) => {
        if (!event.data || event.data.size === 0) return;
        const pushJob = (async () => {
          const audio = await blobToBase64(event.data);
          await pushChunk(audio, false);
        })();
        pendingPushesRef.current.push(pushJob);
        await pushJob.finally(() => {
          pendingPushesRef.current = pendingPushesRef.current.filter((job) => job !== pushJob);
        });
      };
      recorder.onstop = () => {
        void Promise.allSettled(pendingPushesRef.current)
          .then(() => pushChunk('', true))
          .finally(() => {
            stream.getTracks().forEach((track) => track.stop());
            setIsRecording(false);
            setStatus('识别中');
          });
      };
      recorder.start(1000);
      setIsRecording(true);
      setStatus('录音中');
      appendLog('recording_started', { mime_type: recorder.mimeType || mimeType, format });
    } catch (e) {
      cleanup();
      setIsRecording(false);
      setStatus(`录音失败：${errorMessage(e)}`);
      appendLog('recording_error', { message: errorMessage(e) });
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      appendLog('recording_stop');
      recorderRef.current.stop();
      setStatus('停止录音，等待识别');
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
          <span>浏览器录音测试</span>
        </div>
        <span className={`badge ${isRecording ? 'warn' : transcript ? 'ok' : ''}`}>
          <span className={`dot ${isRecording ? 'pulse' : ''}`} />
          <span>{status}</span>
        </span>
      </h3>

      <div className="flex gap-2 flex-wrap mb-4">
        <button onClick={startRecording} disabled={isRecording} className="primary">
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

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
        <div className="bg-white border border-border rounded-xl min-h-[260px] p-6">
          <div className="text-[11px] text-muted font-semibold mb-3">转写白屏</div>
          <div className="text-[22px] leading-relaxed text-fg whitespace-pre-wrap break-words">
            {transcript || <span className="text-muted-2">等待识别文本…</span>}
          </div>
        </div>

        <div className="panel p-4 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h4 className="section-title text-sm">
              <ClipboardCopy className="w-4 h-4 text-accent-2" />
              <span>调试日志</span>
            </h4>
            <div className="flex gap-2">
              <button onClick={copyLogs} disabled={logs.length === 0}>
                <ClipboardCopy className="w-3.5 h-3.5" />
                <span>复制日志</span>
              </button>
              <button onClick={() => setLogs([])} disabled={logs.length === 0}>
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空</span>
              </button>
            </div>
          </div>
          <textarea
            readOnly
            value={logs.join('\n')}
            className="w-full h-[210px] font-mono text-[11px] leading-relaxed bg-white"
            placeholder="录音、上传、SSE 事件和错误会显示在这里。"
          />
        </div>
      </div>
    </div>
  );
};
