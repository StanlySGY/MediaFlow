import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Download, Info, Mic, MicOff, Square, Trash2 } from 'lucide-react';
import { StandardASRStreamEvent } from '../types';
import { errorMessage, responseError } from '../lib/errors';
import { applySplice } from '../lib/splice';
import { buildSrtFromCues, buildVttFromCues } from '../lib/subtitle';
import { createRealtimeCueTracker } from '../lib/realtimeCueTracker';
import { downloadFile } from '../lib/download';
import { formatSize } from '../lib/uploadPreflight';
import {
  CAPACITY_RETRY_MAX_ATTEMPTS,
  CAPACITY_TERMINAL_STATUSES,
  blobToBase64,
  capacityRetryNotice,
  createSessionWithCapacityRetry,
  formatFromMime,
  microphoneErrorMessage,
  parseCapacityRefusal,
  pickRecorderMimeType,
  transcriptFileName,
} from '../lib/realtimeRecording';
import { enumLabel, REALTIME_LABELS, realtimeProviderGuide, realtimeProviderNote } from '../lib/labels';
import { Accordion } from './Accordion';
import { AudioLevelMeter } from './AudioLevelMeter';

interface RealtimeRecorderPanelProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  sseUrl: (path: string) => string;
  realtimeProvider?: string;
  /** Server-side cap on simultaneous recordings (realtime_max_sessions). */
  maxSessions?: number;
  /** Jumps to 服务配置. Only the provider guide needs it, but a guide that
   *  cannot be acted on is just a complaint. */
  onOpenConfig?: () => void;
}

type RealtimeRecorderState = 'idle' | 'connecting' | 'recording' | 'processing' | 'completed' | 'error';

const RECORDER_STATUS: Record<RealtimeRecorderState, string> = {
  idle: '未录音',
  connecting: '连接中…',
  recording: '录音中',
  processing: '识别中',
  completed: '识别完成',
  error: '发生错误',
};

export const RealtimeRecorderPanel: React.FC<RealtimeRecorderPanelProps> = ({
  authedFetch,
  sseUrl,
  realtimeProvider,
  maxSessions,
  onOpenConfig,
}) => {
  const [state, setState] = useState<RealtimeRecorderState>('idle');
  const isRecording = state === 'recording';
  const isBusy = state === 'connecting' || state === 'recording' || state === 'processing';
  const status = RECORDER_STATUS[state];
  const [transcript, setTranscript] = useState('');
  const [transcriptFeedback, setTranscriptFeedback] = useState('');
  const [logsFeedback, setLogsFeedback] = useState('');
  const [notice, setNotice] = useState('');
  // Separate from `notice` on purpose: a capacity wait is not an error, and an
  // error-coloured alert over a 4/4 badge that is about to clear reads as a
  // failure the user has to go fix.
  const [capacityWait, setCapacityWait] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [chunks, setChunks] = useState(0);
  const [bytes, setBytes] = useState(0);
  // null = not fetched yet. Advisory only: the server re-checks the cap when
  // the session is created, so a stale count can never start a 5th recording.
  const [liveSessions, setLiveSessions] = useState<number | null>(null);
  // Live microphone stream, kept in state (not only in a ref) so the level
  // meter can attach to it the moment the recorder starts.
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  // Whether the recorder has ever seen a non-silent frame. A muted or wrong
  // input device produces a perfectly normal-looking recording that ends with
  // an empty transcript; this is the only point where that is still fixable.
  const [heardSound, setHeardSound] = useState(false);
  const [silentFor, setSilentFor] = useState(0);
  // How many sentence boundaries this recording has closed. The cue tracker
  // itself lives in a ref (it is event state, not render state), but the export
  // note is render text, so the count it needs is mirrored here.
  const [boundaryCount, setBoundaryCount] = useState(0);
  const mountedRef = useRef(true);

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
  // Subtitle cues for this recording. The server archives a realtime session
  // with no segments because the upstream frames carry no utterance timestamps;
  // what is measurable is this client's clock, so the boundaries are recorded
  // here as the events arrive (see lib/realtimeCueTracker).
  const cueTrackerRef = useRef(createRealtimeCueTracker());
  const sessionStartRef = useRef(0);

  const refreshCapacity = useCallback(async () => {
    // Without a known cap the count has nothing to be compared against, so do
    // not spend a request on it.
    if (typeof maxSessions !== 'number') return;
    try {
      const response = await authedFetch('/asr/realtime/sessions');
      if (!response.ok) return;
      const data = await response.json();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const live = sessions.filter(
        (ses: { status?: string }) => !CAPACITY_TERMINAL_STATUSES.includes(ses?.status || ''),
      ).length;
      if (mountedRef.current) setLiveSessions(live);
    } catch {
      /* capacity is advisory; the create call reports the real answer */
    }
  }, [authedFetch, maxSessions]);

  // Silence watchdog. MediaRecorder happily encodes a muted track, so the
  // first evidence of a dead microphone used to be an empty transcript after
  // the recording ended. Levels arrive ~4Hz from the meter; the threshold sits
  // above room tone so a quiet-but-live room does not trip it.
  const lastSoundAtRef = useRef(0);
  const handleInputLevel = useCallback((level: number) => {
    if (level > 0.08) {
      lastSoundAtRef.current = Date.now();
      setHeardSound(true);
    }
  }, []);

  const appendLog = (event: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    setLogs((prev) => [...prev.slice(-199), line]);
  };

  useEffect(() => {
    if (!isRecording) return;

    const started = Date.now();
    lastSoundAtRef.current = started;
    let warned = false;
    const timer = window.setInterval(() => {
      const since = Date.now() - lastSoundAtRef.current;
      // Grace period: the first frames are quiet while the device ramps up.
      setSilentFor(since > 3000 ? Math.floor(since / 1000) : 0);
      // One line per recording is enough to diagnose a dead input; repeating
      // it every second would bury the rest of the log.
      if (!warned && since > 3000) {
        warned = true;
        appendLog('input_silent', { seconds: Math.floor(since / 1000) });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording]);

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
    setMicStream(null);
    if (sessionId) {
      void releaseSession(sessionId).finally(() => {
        // Session creation updates the capacity badge before getUserMedia may
        // reject. Refresh after DELETE completes so a denied microphone does
        // not leave a stale "in use" count on the idle/error screen.
        if (mountedRef.current) void refreshCapacity();
      });
    }
  }, [refreshCapacity, releaseSession]);

  useEffect(() => {
    // maxSessions is populated asynchronously from app config. This effect is
    // re-run when that prop changes, so restore the mounted flag on every setup
    // or all later capacity refreshes would be ignored after the first cleanup.
    mountedRef.current = true;
    // Wrapped in a microtask-free async IIFE so the count lands in a callback
    // rather than the effect body (react-hooks/set-state-in-effect).
    void (async () => {
      await refreshCapacity();
    })();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      cleanup();
    };
  }, [cleanup, refreshCapacity]);

  // Wall clock of the session, used when a provider frame carries no elapsed_ms
  // of its own. The server's own counter starts at session creation, which is
  // the same instant this ref is set at.
  const sessionElapsedMs = () =>
    sessionStartRef.current ? Date.now() - sessionStartRef.current : 0;

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
      // EventSource reconnects by itself, and the server rebuilds the delta
      // chain from an empty baseline for every new connection (previous_text is
      // per-connection in stream_realtime_session; there is no Last-Event-ID
      // resume), so the replayed events only line up against a cleared local
      // transcript — removing this reset would double-apply the replay.
      if (hasOpened) {
        committedTextRef.current = '';
        cueTrackerRef.current.reset();
        setBoundaryCount(0);
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
        // `source_event` is the provider's own event type. `final` is the one
        // frame where upstream says "this sentence is settled", so it is the
        // only boundary worth cutting a subtitle on.
        if (event.source_event === 'final') {
          cueTrackerRef.current.closeBoundary(
            committedTextRef.current.length,
            event.elapsed_ms ?? sessionElapsedMs(),
          );
          setBoundaryCount(cueTrackerRef.current.boundaryCount());
        }
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
    // A previous exhausted wait belongs to the attempt that ended, not this one.
    setCapacityWait('');
    setIsReconnecting(false);
    committedTextRef.current = '';
    cueTrackerRef.current.reset();
    setBoundaryCount(0);
    sessionStartRef.current = Date.now();
    setLogs([]);
    setChunks(0);
    setBytes(0);
    setMicStream(null);
    setSilentFor(0);
    setHeardSound(false);
    lastSoundAtRef.current = Date.now();
    seqRef.current = 0;
    pushChainRef.current = Promise.resolve();

    const mimeType = pickRecorderMimeType();
    const format = formatFromMime(mimeType);
    formatRef.current = format;
    appendLog('session_create_start', { mime_type: mimeType, format });
    let recordingSessionId = '';

    try {
      // A full cap is a wait, not an error: the panel retries on the server's
      // own schedule and keeps the badge honest while it waits, so "在用 4/4 路"
      // and the sentence under the button say the same thing.
      const sessionResponse = await createSessionWithCapacityRetry(
        () =>
          authedFetch('/asr/realtime/session', {
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
          }),
        {
          shouldAbort: () => generation !== generationRef.current,
          onRefused: (refusal, attempt) => {
            if (generation !== generationRef.current) return;
            setCapacityWait(capacityRetryNotice(refusal, attempt));
            // The refusal's counters are more current than the last
            // GET /realtime/sessions, so the badge shows the same numbers the
            // sentence quotes instead of a stale count beside it.
            if (refusal.live !== null) setLiveSessions(refusal.live);
            void refreshCapacity();
            appendLog('session_capacity_wait', {
              attempt: attempt + 1,
              live: refusal.live,
              limit: refusal.limit,
            });
          },
        },
      );
      if (!sessionResponse.ok) {
        const error = await responseError(sessionResponse);
        const refusal = parseCapacityRefusal(error);
        if (refusal && generation === generationRef.current) {
          // Retries are used up. The neutral wait line already says what to do
          // (free a slot, or raise REALTIME_MAX_SESSIONS), so an error-coloured
          // repeat of the same numbers would only read as a crash.
          setCapacityWait(capacityRetryNotice(refusal, CAPACITY_RETRY_MAX_ATTEMPTS));
          setNotice('');
          setState('idle');
          appendLog('session_capacity_exhausted', {
            live: refusal.live,
            limit: refusal.limit,
          });
          return;
        }
        throw error;
      }
      setCapacityWait('');
      setNotice('');
      const session = await sessionResponse.json();
      if (generation !== generationRef.current) {
        releaseSession(session.session_id);
        return;
      }
      recordingSessionId = session.session_id as string;
      sessionIdRef.current = recordingSessionId;
      // Our own session now holds one of the shared slots.
      void refreshCapacity();
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
      setMicStream(stream);
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
      setNotice(microphoneErrorMessage(e));
      appendLog('recording_error', {
        name: (e as { name?: string })?.name || null,
        message: errorMessage(e),
      });
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      appendLog('recording_stop');
      recorderRef.current.stop();
      if (!uploadFailedRef.current) setState('processing');
      void refreshCapacity();
    }
  };

  // Escape stops the recording: reaching for the mouse mid-sentence loses the
  // thread of what is being said.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isRecording) return;
      const target = event.target as HTMLElement | null;
      // Escape in a text field or dialog means "cancel that", not "stop".
      if (target?.closest('input, textarea, select, [role="dialog"]')) return;
      event.preventDefault();
      stopRecording();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const copyLogs = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(logs.join('\n'));
      setLogsFeedback('调试日志已复制到剪贴板');
    } catch {
      setLogsFeedback('无法访问剪贴板，请手动选择下方日志复制');
    }
  };

  const downloadSubtitle = (format: 'srt' | 'vtt') => {
    const cues = cueTrackerRef.current.cues(transcript, sessionElapsedMs());
    if (cues.length === 0) return;
    const body = format === 'srt' ? buildSrtFromCues(cues) : buildVttFromCues(cues);
    downloadFile(transcriptFileName(format), body, 'text/plain;charset=utf-8');
  };

  /** What the SRT/VTT timestamps actually are. They come from this browser's
   *  clock and the upstream sentence boundaries, never from the audio file —
   *  a realtime session has no audio file, and the server says so out loud by
   *  archiving it without segments. */
  const subtitleNote = boundaryCount === 0
    ? '字幕时间按本次录音的墙钟计时（上游未给出整句切点，导出为一整条）'
    : `字幕时间按本次录音的墙钟计时，${boundaryCount} 个切点取上游判定为整句的时刻`;

  const providerGuide = realtimeProviderGuide(realtimeProvider);

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
        <div className="flex items-center gap-2 min-w-0">
          <Mic className="w-4 h-4 text-muted shrink-0" />
          <span>实时录音</span>
          {realtimeProvider && (
            <span className="text-meta font-normal text-muted-2 truncate">
              {realtimeProviderNote(realtimeProvider)}
            </span>
          )}
          {typeof maxSessions === 'number' && (
            <span
              className="text-meta font-normal text-muted-2"
              title="名额由服务端按所有客户端的活跃会话计数，别人正在录音也会占用"
            >
              {liveSessions === null
                ? `并发上限 ${maxSessions} 路`
                : `在用 ${liveSessions}/${maxSessions} 路`}
            </span>
          )}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 text-sm font-medium ${
            isRecording ? 'text-warn' : transcript ? 'text-ok' : 'text-muted'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isRecording ? 'bg-warn' : transcript ? 'bg-ok' : 'bg-muted-2'
            }`}
          />
          {status}
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
        <span className="text-sm text-muted tabular-nums self-center">
          已发送 <b className="text-fg font-medium">{chunks}</b> 包 ·
          累计 <b className="text-fg font-medium">{formatSize(bytes)}</b>
        </span>
        {isRecording && (
          // Keyboard-only hint: on a touch device there is no Escape key, so
          // it would just be a line of noise under the buttons.
          <span className="text-meta text-muted-2 self-center hidden [@media(hover:hover)]:inline">
            Esc 停止录音
          </span>
        )}
      </div>

      {/* Input level. Shown from the moment the microphone opens, because
          "is this thing hearing me" is the question the button row cannot
          answer. */}
      {(isRecording || state === 'connecting') && (
        <div className="mb-4 flex items-center gap-3">
          <span className="text-meta text-muted shrink-0">
            {heardSound ? '输入电平' : '等待声音'}
          </span>
          <AudioLevelMeter stream={micStream} active={isRecording} onLevel={handleInputLevel} className="flex-1 min-w-0" />
        </div>
      )}

      {isRecording && silentFor >= 3 && (
        <div
          className="flex items-start gap-2 p-3 mb-4 rounded-lg border border-warn/25 bg-warn-soft text-warn text-[13px]"
          role="status"
          aria-live="polite"
        >
          <MicOff className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            已连续 {silentFor} 秒没有收到声音。请检查麦克风是否被静音、系统输入设备选得对不对，
            以及浏览器地址栏的麦克风权限；否则这次录音不会出字。
          </span>
        </div>
      )}

      {capacityWait && (
        <div
          className="p-3 mb-4 rounded-lg border border-border bg-surface-2 text-[13px] text-muted"
          role="status"
          aria-live="polite"
        >
          {capacityWait}
        </div>
      )}
      {notice && (
        <div className="p-3 mb-4 rounded-lg border border-err/20 bg-err-soft text-err text-[13px]" role="alert">
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

      {providerGuide && (
        // Not a first-run tip: the demo/offline providers keep behaving
        // differently from a streaming one no matter how often the page has
        // been used, and the difference is invisible until the recording ends.
        <div
          className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-border bg-surface-2 text-[13px] text-muted"
          role="status"
        >
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-muted-2" />
          <div className="min-w-0 flex-1">
            <span className="text-fg font-medium">
              {enumLabel(REALTIME_LABELS, realtimeProvider) || '实时 provider 未设置'}
            </span>
            <p className="mt-1 leading-snug break-words">{providerGuide}</p>
          </div>
          {onOpenConfig && (
            <button onClick={onOpenConfig} className="text-[12px] py-1 px-2.5 shrink-0">
              去服务配置
            </button>
          )}
        </div>
      )}

      <div className="bg-surface border border-border rounded-[10px] min-h-[240px] p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="text-meta text-muted font-medium">
            {state === 'completed' ? '最终稿' : '实时文稿'}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={copyTranscript} disabled={!transcript} className="text-[12px] py-1.5 px-3">
              <ClipboardCopy className="w-3.5 h-3.5" />
              <span>复制文稿</span>
            </button>
            <button
              onClick={() => downloadFile(transcriptFileName(), transcript, 'text/plain;charset=utf-8')}
              disabled={!transcript}
              className="text-[12px] py-1.5 px-3"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载 TXT</span>
            </button>
            <button
              onClick={() => downloadSubtitle('srt')}
              disabled={!transcript}
              title={subtitleNote}
              className="text-[12px] py-1.5 px-3"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载 SRT</span>
            </button>
            <button
              onClick={() => downloadSubtitle('vtt')}
              disabled={!transcript}
              title={subtitleNote}
              className="text-[12px] py-1.5 px-3"
            >
              <Download className="w-3.5 h-3.5" />
              <span>下载 VTT</span>
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
        <div className="text-[16px] leading-[1.9] text-fg whitespace-pre-wrap break-words">
          {transcript || <span className="text-muted-2">等待识别文本…</span>}
        </div>
        {transcript && (
          // The SRT/VTT timestamps are measured, and what they are measured
          // against has to be said out loud — a title attribute is invisible
          // on a touch device and unreadable until someone hovers a button.
          <p className="text-meta text-muted-2 mt-3 leading-snug">{subtitleNote}</p>
        )}
      </div>

      <div className="mt-4">
        <Accordion title={logs.length > 0 ? `调试日志 · ${logs.length} 条` : '调试日志'}>
        <div className="p-5 min-w-0">
          <div className="flex items-center justify-end gap-2 mb-3">
            <button onClick={copyLogs} disabled={logs.length === 0} className="text-meta py-0.5 px-2">
              <ClipboardCopy className="w-3 h-3" />
              <span>复制</span>
            </button>
            <button onClick={() => setLogs([])} disabled={logs.length === 0} className="text-meta py-0.5 px-2">
              <Trash2 className="w-3 h-3" />
              <span>清空</span>
            </button>
          </div>
          {logsFeedback && (
            <p className="text-[12px] mb-2" role={logsFeedback.startsWith('无法访问') ? 'alert' : 'status'} aria-live="polite">
              {logsFeedback}
            </p>
          )}
          <textarea
            readOnly
            value={logs.join('\n')}
            className="w-full h-[160px] font-mono text-meta leading-relaxed rounded-[8px] bg-console border border-console-border text-console-text px-3 py-2.5 resize-y"
            placeholder="录音、上传、SSE 事件和错误会显示在这里。"
          />
        </div>
        </Accordion>
      </div>
    </div>
  );
};
