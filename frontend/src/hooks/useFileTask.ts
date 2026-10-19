import { useEffect, useState, useRef } from 'react';
import type { ASRSegment, StandardASRStreamEvent } from '../types';
import { buildSrt, buildVtt } from '../lib/subtitle';
import { downloadFile, formatDur } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { rejectUploadFile, type UploadLimits } from '../lib/uploadPreflight';

type AuthedFetch = (url: string, opts?: RequestInit) => Promise<Response>;
type SseUrl = (path: string) => string;
type RawSeg = {
  segment_id: number; start: number; end: number; text: string;
  error?: string | null; elapsed_ms?: number;
};
type RawTaskInfo = {
  status?: string;
  progress?: number;
  total_segments?: number;
  finished_segments?: number;
  // The backend classifies every failure into error / error_code / hint /
  // retryable (see TaskManager._failure_protocol). Reading only status leaves
  // the page saying "失败" with no reason and no way to tell a quota rejection
  // from a one-off upstream blip that a resend would fix.
  error?: string | null;
  error_code?: string | null;
  hint?: string | null;
  retryable?: boolean | null;
};
type RawTaskResult = RawTaskInfo & {
  duration?: number;
  text?: string;
  segments?: RawSeg[];
};

const FILE_TASK_STORAGE_KEY = 'asr_file_task_id';
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

const readPersistedTaskId = () => {
  try { return localStorage.getItem(FILE_TASK_STORAGE_KEY); }
  catch { return null; }
};

const persistTaskId = (id: string | null) => {
  try {
    if (id) localStorage.setItem(FILE_TASK_STORAGE_KEY, id);
    else localStorage.removeItem(FILE_TASK_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
};

const STATUS_LABEL: { [k: string]: string } = {
  'uploading': '上传中', 'pending': '排队中', 'preprocessing': '预处理',
  'splitting': '切分中', 'transcribing': '识别中', 'merging': '合并中',
  'done': '已完成', 'failed': '失败', 'cancelled': '已取消', '—': '—',
};

// Owns the whole file-transcription lifecycle: upload (XHR for progress), SSE segment
// stream, status polling, result fetch, local-media proofreading and subtitle export.
// App only wires the returned state/handlers into the JSX.
export function useFileTask(authedFetch: AuthedFetch, sseUrl: SseUrl, limits: UploadLimits = {}) {
  const [segments, setSegments] = useState<ASRSegment[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<string>('—');
  const [taskTotalSegs, setTaskTotalSegs] = useState<number | string>('—');
  const [taskFinSegs, setTaskFinSegs] = useState<number>(0);
  const [taskDuration, setTaskDuration] = useState<string>('—');
  const [taskProgress, setTaskProgress] = useState<number>(0);
  const [fullText, setFullText] = useState<string>('');

  // Per-task parameter overrides (Accordion form).
  const [ovModel, setOvModel] = useState('');
  const [ovLanguage, setOvLanguage] = useState('');
  const [ovSplit, setOvSplit] = useState('');
  const [ovChunk, setOvChunk] = useState('');
  const [ovOverlap, setOvOverlap] = useState('');
  const [ovHotwords, setOvHotwords] = useState('');
  const [ovHints, setOvHints] = useState('');
  const [ovTimestamps, setOvTimestamps] = useState(true);
  const [ovTimestampsTouched, setOvTimestampsTouched] = useState(false);

  // Inline error channel replacing window.alert(). The alerts froze the tab and
  // vanished the moment they were dismissed, so a failed upload left the page
  // looking idle with the reason nowhere to be read.
  const [taskError, setTaskError] = useState<string | null>(null);
  // Whether the failure the banner is describing can be fixed by resending the
  // same file — the server already decided this when it classified the error.
  const [taskRetryable, setTaskRetryable] = useState(false);
  // The server's own advice about the failure ("取消后再删除", "请重新提交该
  // 文件") and the stable code behind it, kept separate from the message so
  // the banner can show them as their own lines.
  // A retry is only offered when the failed file is still in this tab — after
  // a page reload the persisted task id is there but the File object is not.
  const [hasSubmittableFile, setHasSubmittableFile] = useState(false);
  const [taskErrorHint, setTaskErrorHint] = useState<string | null>(null);
  const [taskErrorCode, setTaskErrorCode] = useState<string | null>(null);

  const [activePane, setActivePane] = useState<'live' | 'final'>('live');
  const [copied, setCopied] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(-1);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaIsVideo, setMediaIsVideo] = useState(false);
  const [segmentsEdited, setSegmentsEdited] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRef = useRef<HTMLAudioElement & HTMLVideoElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const taskIdRef = useRef<string | null>(null);
  // The last file handed to the pipeline, kept so a retryable failure can be
  // resubmitted without asking the user to find the file again.
  const lastFileRef = useRef<File | null>(null);
  const taskGenerationRef = useRef(0);
  const terminalHandlingRef = useRef<string | null>(null);

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

  const clearTaskView = () => {
    stopTaskStream();
    setTaskRetryable(false);
    setHasSubmittableFile(false);
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
    taskIdRef.current = null;
    terminalHandlingRef.current = null;
  };

  const resetTask = async () => {
    const generation = ++taskGenerationRef.current;
    const currentTaskId = taskIdRef.current;
    persistTaskId(null);
    if (currentTaskId) {
      try {
        const response = await authedFetch(`/asr/task/${currentTaskId}/cancel`, { method: 'POST' });
        if (!response.ok && response.status !== 404) {
          console.warn(`Failed to cancel task ${currentTaskId}: HTTP ${response.status}`);
        }
      } catch (error) {
        console.warn(`Failed to cancel task ${currentTaskId}`, error);
      }
    }
    if (generation !== taskGenerationRef.current) return generation;
    clearTaskView();
    return generation;
  };

  /**
   * Stop an in-flight task but keep the workspace on screen.
   *
   * resetTask() (清空) throws the whole view away, which is not what "stop this
   * run" means: the segments already recognized are real work, and the user who
   * cancels a 40-minute file usually wants the first 10 minutes of it. The
   * server flips the task to cancelled at the next stage boundary, the stream
   * closes, and the terminal path fills in whatever the pipeline managed to
   * merge.
   */
  const abortTask = async () => {
    const currentTaskId = taskIdRef.current;
    if (!currentTaskId) return false;
    try {
      const response = await authedFetch(`/asr/task/${currentTaskId}/cancel`, { method: 'POST' });
      if (!response.ok && response.status !== 404) {
        setTaskError(`中止任务失败：HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      setTaskError(`中止任务失败：${errorMessage(error)}`);
      return false;
    }
  };

  const detachTaskView = () => {
    const generation = ++taskGenerationRef.current;
    persistTaskId(null);
    clearTaskView();
    return generation;
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
    // Preflight against the limits the server reported, before any bytes go on
    // the wire: a rejected file used to cost a full upload attempt (a cancelled
    // task, a progress bar, then a 400/413 arriving after minutes of transfer).
    // Checked before resetTask so a mistyped pick cannot destroy the task the
    // user is still looking at.
    const rejected = rejectUploadFile(file, limits);
    if (rejected) {
      setTaskError(rejected);
      return;
    }

    const generation = await resetTask();
    if (generation !== taskGenerationRef.current) return;
    lastFileRef.current = file;
    setHasSubmittableFile(true);
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
    let tok = '';
    try { tok = localStorage.getItem('asr_token') || ''; }
    catch { /* Continue without a token if browser storage is unavailable. */ }
    try {
      const data = await new Promise<{ task_id: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open('POST', '/asr/file');
        if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
        xhr.upload.onprogress = (e) => {
          if (generation === taskGenerationRef.current && e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhrRef.current === xhr) xhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { reject(new Error('返回解析失败')); }
          } else {
            reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => {
          if (xhrRef.current === xhr) xhrRef.current = null;
          reject(new Error('网络错误'));
        };
        xhr.onabort = () => {
          if (xhrRef.current === xhr) xhrRef.current = null;
          reject(new Error('已取消'));
        };
        xhr.send(fd);
      });

      if (generation !== taskGenerationRef.current) {
        void authedFetch(`/asr/task/${data.task_id}/cancel`, { method: 'POST' }).catch(() => {});
        return;
      }
      if (typeof data.task_id !== 'string' || !data.task_id) {
        throw new Error('返回任务 ID 无效');
      }
      setUploadProgress(-1);
      persistTaskId(data.task_id);
      setTaskId(data.task_id);
      taskIdRef.current = data.task_id;
      startTaskStream(data.task_id, generation);
    } catch (e) {
      if (generation !== taskGenerationRef.current) return;
      setUploadProgress(-1);
      const msg = errorMessage(e);
      if (msg === '已取消') return;
      setTaskStatus('failed');
      setTaskError(`上传失败：${msg}`);
    }
  };

  const isCurrentTask = (id: string, generation: number) => (
    generation === taskGenerationRef.current && taskIdRef.current === id
  );

  const stopTaskStream = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const applyTaskInfo = (info: RawTaskInfo) => {
    setTaskStatus(info.status || '—');
    if (typeof info.total_segments === 'number') setTaskTotalSegs(info.total_segments);
    if (typeof info.finished_segments === 'number') setTaskFinSegs(info.finished_segments);
    setTaskProgress(typeof info.progress === 'number' ? info.progress : 0);
  };

  const applyTaskResult = (
    id: string,
    generation: number,
    result: RawTaskResult,
    fallbackProgress = 0,
  ) => {
    if (!isCurrentTask(id, generation)) return;
    const finalSegments: ASRSegment[] = (result.segments || []).map((s) => ({
      segment_id: s.segment_id,
      start: s.start,
      end: s.end,
      text: s.text,
      error: s.error ?? null,
      is_final: true,
      elapsed_ms: s.elapsed_ms || 0,
    }));
    const status = result.status || 'done';
    setSegments(finalSegments);
    setSegmentsEdited(false);
    setTaskTotalSegs(finalSegments.length);
    setTaskFinSegs(finalSegments.length);
    setFullText(result.text || '');
    setTaskDuration(result.duration ? formatDur(result.duration) : '—');
    setTaskStatus(status);
    setTaskProgress(status === 'done' ? 1 : fallbackProgress);
    setActivePane('final');

    // A failed or cancelled run still shows whatever the pipeline managed to
    // merge above; the banner below explains why it stopped and whether a
    // resend is worth trying.
    if (status === 'failed' || status === 'cancelled') {
      setTaskError(result.error || (status === 'cancelled' ? '任务已取消' : '转写失败'));
      setTaskErrorHint(result.hint || null);
      setTaskErrorCode(result.error_code || null);
      setTaskRetryable(result.retryable === true);
    } else {
      setTaskError(null);
      setTaskErrorHint(null);
      setTaskErrorCode(null);
      setTaskRetryable(false);
    }
  };

  const markTaskMissing = (id: string, generation: number) => {
    if (!isCurrentTask(id, generation)) return;
    stopTaskStream();
    persistTaskId(null);
    taskIdRef.current = null;
    terminalHandlingRef.current = null;
    setTaskId(null);
    setTaskStatus('—');
    setTaskTotalSegs('—');
    setTaskFinSegs(0);
    setTaskDuration('—');
    setTaskProgress(0);
    setSegments([]);
    setFullText('');
  };

  const finishTerminalTask = async (id: string, generation: number, fallbackProgress = 0) => {
    if (!isCurrentTask(id, generation)) return;
    const terminalKey = `${generation}:${id}`;
    if (terminalHandlingRef.current === terminalKey) return;
    terminalHandlingRef.current = terminalKey;
    stopTaskStream();

    try {
      const response = await authedFetch(`/asr/file/${id}/result`);
      if (!isCurrentTask(id, generation)) return;
      if (response.status === 404) {
        markTaskMissing(id, generation);
        return;
      }
      if (!response.ok) {
        terminalHandlingRef.current = null;
        pollTimerRef.current = setTimeout(() => {
          void finishTerminalTask(id, generation, fallbackProgress);
        }, 2000);
        return;
      }
      const result = await response.json() as RawTaskResult;
      if (!isCurrentTask(id, generation)) return;
      applyTaskResult(id, generation, result, fallbackProgress);
    } catch {
      if (!isCurrentTask(id, generation)) return;
      terminalHandlingRef.current = null;
      pollTimerRef.current = setTimeout(() => {
        void finishTerminalTask(id, generation, fallbackProgress);
      }, 2000);
    }
  };

  const schedulePoll = (id: string, generation: number, delay: number) => {
    if (!isCurrentTask(id, generation)) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => { void pollTask(id, generation); }, delay);
  };

  const startTaskStream = (id: string, generation: number) => {
    if (!isCurrentTask(id, generation)) return;
    if (esRef.current) esRef.current.close();

    try {
      const es = new EventSource(sseUrl(`/asr/file/${id}/events`));
      esRef.current = es;

      const messageHandler = (e: MessageEvent) => {
        if (!isCurrentTask(id, generation)) return;
        let payload: StandardASRStreamEvent;
        try { payload = JSON.parse(e.data) as StandardASRStreamEvent; }
        catch { return; }
        if (payload.stream !== 'file') return;

        if (payload.type === 'text') {
          const seg: ASRSegment = {
            segment_id: payload.segment_id ?? payload.seq ?? 0,
            start: payload.start ?? 0,
            end: payload.end ?? 0,
            text: payload.text || '',
            is_final: payload.is_final,
            elapsed_ms: payload.elapsed_ms || 0,
            error: payload.error || null,
          };
          setSegments((prev) => {
            const nextMap = new Map(prev.map(s => [s.segment_id, s]));
            nextMap.set(seg.segment_id, seg);
            const nextList = [...nextMap.values()];
            setTaskFinSegs(nextList.filter(s => s.is_final).length);
            return nextList;
          });
          return;
        }

        if (payload.type === 'done' || payload.type === 'error') {
          void finishTerminalTask(id, generation, payload.progress ?? 0);
        }
      };

      es.addEventListener('message', messageHandler);
      // Do not close on network errors; EventSource reconnects and the server replays events.
    } catch {
      // Polling remains available if EventSource cannot be constructed.
    }
    void pollTask(id, generation);
  };

  const pollTask = async (id: string, generation: number) => {
    if (!id || !isCurrentTask(id, generation)) return;
    try {
      const response = await authedFetch(`/asr/file/${id}`);
      if (!isCurrentTask(id, generation)) return;
      if (response.status === 404) {
        markTaskMissing(id, generation);
        return;
      }
      if (!response.ok) {
        schedulePoll(id, generation, 2000);
        return;
      }
      const info = await response.json() as RawTaskInfo;
      if (!isCurrentTask(id, generation)) return;
      applyTaskInfo(info);
      if (info.status && TERMINAL_STATUSES.has(info.status)) {
        void finishTerminalTask(id, generation, info.progress || 0);
        return;
      }
      schedulePoll(id, generation, 1000);
    } catch {
      schedulePoll(id, generation, 2000);
    }
  };

  // Load a historical task without cancelling the task currently shown in this view.
  const loadHistoricalTask = async (tid: string): Promise<boolean> => {
    const generation = detachTaskView();
    if (generation !== taskGenerationRef.current) return false;
    try {
      const statusResponse = await authedFetch(`/asr/file/${tid}`);
      if (generation !== taskGenerationRef.current) return false;
      if (!statusResponse.ok) throw new Error(`HTTP ${statusResponse.status}`);
      const info = await statusResponse.json() as RawTaskInfo;
      if (generation !== taskGenerationRef.current) return false;

      // No local media for historical tasks — clear any lingering player.
      setMediaUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
      setMediaIsVideo(false);
      setSegmentsEdited(false);

      if (!info.status || !TERMINAL_STATUSES.has(info.status)) {
        setTaskId(tid);
        taskIdRef.current = tid;
        persistTaskId(tid);
        applyTaskInfo(info);
        startTaskStream(tid, generation);
        return true;
      }

      const resultResponse = await authedFetch(`/asr/file/${tid}/result`);
      if (generation !== taskGenerationRef.current) return false;
      if (!resultResponse.ok) throw new Error(`HTTP ${resultResponse.status}`);
      const result = await resultResponse.json() as RawTaskResult;
      if (generation !== taskGenerationRef.current) return false;
      setTaskId(tid);
      taskIdRef.current = tid;
      persistTaskId(tid);
      applyTaskResult(tid, generation, result, info.progress || 0);
      return true;
    } catch (e) {
      setTaskError(`打开历史记录失败：${errorMessage(e)}`);
      return false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    const generation = taskGenerationRef.current;
    const persistedId = readPersistedTaskId();
    if (!persistedId) {
      return () => { cancelled = true; };
    }

    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cancelled || generation !== taskGenerationRef.current) return;
        try {
          const response = await authedFetch(`/asr/file/${persistedId}`);
          if (cancelled || generation !== taskGenerationRef.current) return;
          if (response.status === 404) {
            persistTaskId(null);
            return;
          }
          if (!response.ok) {
            if (response.status !== 429 && response.status < 500) return;
          } else {
            const info = await response.json() as RawTaskInfo;
            if (cancelled || generation !== taskGenerationRef.current) return;
            taskIdRef.current = persistedId;
            setTaskId(persistedId);
            applyTaskInfo(info);
            startTaskStream(persistedId, generation);
            return;
          }
        } catch {
          // A later attempt can recover from a temporary network failure.
        }
        if (attempt < 2) {
          await new Promise(resolve => window.setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
    })();

    return () => {
      cancelled = true;
      taskGenerationRef.current += 1;
      stopTaskStream();
    };
  // Recovery runs once for the mounted hook; auth callbacks are stable and read current credentials.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedFetch]);

  const statusLabel = (s: string) => STATUS_LABEL[s] || s;

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
      const r = await authedFetch(`/asr/file/${taskId}/subtitle?format=${fmt}`);
      if (!r.ok) {
        setTaskError(`导出字幕失败：HTTP ${r.status}`);
        return;
      }
      downloadFile(`${taskId}.${fmt}`, await r.text(), mime);
    } catch (e) {
      setTaskError(`导出字幕失败：${errorMessage(e)}`);
    }
  };

  /**
   * Resend the last submitted file after a failure the server labelled
   * retryable. Cancelled and permanent failures (bad audio, rejected by the
   * upstream) are not resent — the server already decided which is which.
   */
  const retryTask = async () => {
    const file = lastFileRef.current;
    if (!file) return false;
    await handleFileSelect(file);
    return true;
  };

  const clearTaskError = () => {
    setTaskError(null);
    setTaskErrorHint(null);
    setTaskErrorCode(null);
    setTaskRetryable(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return {
    segments, taskId, taskStatus, taskTotalSegs, taskFinSegs, taskDuration, taskProgress,
    fullText, setFullText,
    ovModel, setOvModel, ovLanguage, setOvLanguage, ovSplit, setOvSplit,
    ovChunk, setOvChunk, ovOverlap, setOvOverlap, ovHotwords, setOvHotwords,
    ovHints, setOvHints, ovTimestamps, setOvTimestamps, ovTimestampsTouched, setOvTimestampsTouched,
    activePane, setActivePane, copied, taskError, clearTaskError,
    taskErrorHint, taskErrorCode, taskRetryable, canRetryTask: taskRetryable && hasSubmittableFile,
    uploadProgress, mediaUrl, mediaIsVideo, segmentsEdited, mediaRef,
    resetTask, abortTask, retryTask, handleSeek, handleEditSegment, handleFileSelect,
    loadHistoricalTask, statusLabel, downloadSubtitle, handleCopy,
  };
}
