import { useState, useRef } from 'react';
import type { ASRSegment, StandardASRStreamEvent } from '../types';
import { buildSrt, buildVtt } from '../lib/subtitle';
import { downloadFile, formatDur } from '../lib/download';
import { errorMessage } from '../lib/errors';

type AuthedFetch = (url: string, opts?: RequestInit) => Promise<Response>;
type SseUrl = (path: string) => string;
type RawSeg = {
  segment_id: number; start: number; end: number; text: string;
  error?: string | null; elapsed_ms?: number;
};

const STATUS_LABEL: { [k: string]: string } = {
  'uploading': '上传中', 'pending': '排队中', 'preprocessing': '预处理',
  'splitting': '切分中', 'transcribing': '识别中', 'merging': '合并中',
  'done': '已完成', 'failed': '失败', '—': '—',
};

// Owns the whole file-transcription lifecycle: upload (XHR for progress), SSE segment
// stream, status polling, result fetch, local-media proofreading and subtitle export.
// App only wires the returned state/handlers into the JSX.
export function useFileTask(authedFetch: AuthedFetch, sseUrl: SseUrl) {
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
        xhr.open('POST', '/asr/file');
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
    } catch (e) {
      setUploadProgress(-1);
      const msg = errorMessage(e);
      if (msg === '已取消') return;
      setTaskStatus('failed');
      alert('上传音频或发起切分任务失败: ' + msg);
    }
  };

  const startTaskStream = (id: string) => {
    pollTask(id);

    if (esRef.current) esRef.current.close();

    const es = new EventSource(sseUrl(`/asr/file/${id}/events`));
    esRef.current = es;

    const doneHandler = async (payload?: StandardASRStreamEvent) => {
      es.close();
      esRef.current = null;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);

      if (payload?.type === 'error') {
        setTaskStatus('failed');
      }

      const infoResponse = await authedFetch(`/asr/file/${id}`);
      if (infoResponse.ok) {
        const info = await infoResponse.json();
        setTaskStatus(info.status);
        setTaskProgress(1);
      }

      // Fetch full transcript details
      const resultResponse = await authedFetch(`/asr/file/${id}/result`);
      if (resultResponse.ok) {
        const res = await resultResponse.json();
        setFullText(res.text || '');
        setTaskDuration(res.duration ? formatDur(res.duration) : '—');
        setActivePane('final');
      }
    };

    const messageHandler = (e: MessageEvent) => {
      const payload = JSON.parse(e.data) as StandardASRStreamEvent;
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
        doneHandler(payload);
      }
    };

    es.addEventListener('message', messageHandler);

    es.onerror = () => {
      es.close();
      esRef.current = null;
    };
  };

  const pollTask = async (id: string) => {
    if (!id) return;
    try {
      const r = await authedFetch(`/asr/file/${id}`);
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
    } catch {
      pollTimerRef.current = setTimeout(() => pollTask(id), 2000);
    }
  };

  // Load a finished task from history. Returns false on failure (caller skips view switch).
  const loadHistoricalTask = async (tid: string): Promise<boolean> => {
    try {
      const r = await authedFetch(`/asr/task/${tid}/result`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = await r.json();

      // No local media for historical tasks — clear any lingering player.
      setMediaUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
      setMediaIsVideo(false);
      setSegmentsEdited(false);

      setSegments(
        (res.segments || []).map((s: RawSeg) => ({
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
      return true;
    } catch (e) {
      alert('加载历史记录失败: ' + errorMessage(e));
      return false;
    }
  };

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
        alert(`导出字幕失败: HTTP ${r.status}`);
        return;
      }
      downloadFile(`${taskId}.${fmt}`, await r.text(), mime);
    } catch (e) {
      alert(`网络异常: ${errorMessage(e)}`);
    }
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
    activePane, setActivePane, copied,
    uploadProgress, mediaUrl, mediaIsVideo, segmentsEdited, mediaRef,
    resetTask, handleSeek, handleEditSegment, handleFileSelect,
    loadHistoricalTask, statusLabel, downloadSubtitle, handleCopy,
  };
}
