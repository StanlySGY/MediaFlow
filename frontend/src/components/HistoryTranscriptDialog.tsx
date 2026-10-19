import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, Mic } from 'lucide-react';
import { Dialog } from './Dialog';
import { errorMessage, responseError } from '../lib/errors';
import { HistoryTask } from '../types';
import { downloadFile, formatDur } from '../lib/download';

interface Props {
  task: HistoryTask;
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onClose: () => void;
}

interface ResultPayload {
  text?: string;
  language?: string | null;
  duration?: number;
  error?: string | null;
  error_code?: string | null;
  hint?: string | null;
}

/**
 * Read-only reader for an archived recording.
 *
 * Only 文件转写 tasks have a media file and per-segment timestamps. A realtime
 * recording is archived as transcript-only — the upstream frames carry no
 * utterance timing, so there is nothing to line up against a player, and
 * opening it in the 文件转写 workspace produced an empty segment list and no
 * audio. This dialog shows what such a record actually has: the full text, the
 * status it ended in, and the error if it failed.
 */
export const HistoryTranscriptDialog: React.FC<Props> = ({ task, authedFetch, onClose }) => {
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The list row only carries a 200-char preview; the full text lives in the
    // archived result.
    void (async () => {
      try {
        const r = await authedFetch(`/asr/file/${task.task_id}/result`);
        if (!r.ok) throw await responseError(r);
        const data = (await r.json()) as ResultPayload;
        if (!cancelled) setResult(data);
      } catch (e) {
        if (!cancelled) setError(`读取转写结果失败: ${errorMessage(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [authedFetch, task.task_id]);

  const text = result?.text || task.text || '';
  const failure = result?.error || task.error || null;
  const label = task.original_name || '录音转写结果';

  const copyText = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('浏览器拒绝了剪贴板访问，可改用「下载 .txt」');
    }
  };

  return (
    <Dialog
      title={label}
      onClose={onClose}
      panelWidth="max-w-[720px]"
      footer={
        <>
          <button onClick={onClose}>关闭</button>
          <button onClick={() => void copyText()} disabled={!text}>
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? '已复制' : '复制全文'}</span>
          </button>
          <button
            className="primary"
            disabled={!text}
            onClick={() => downloadFile(`${task.task_id}.txt`, text, 'text/plain;charset=utf-8')}
          >
            <Download className="w-3.5 h-3.5" />
            <span>下载 .txt</span>
          </button>
        </>
      }
    >
      <div className="flex items-center gap-2 flex-wrap text-[12px] text-muted-2 mb-3">
        <span className="badge">
          <Mic className="w-3 h-3" />
          <span>实时录音</span>
        </span>
        <span className="font-mono">#{task.task_id}</span>
        {task.created_at && <span>{new Date(task.created_at * 1000).toLocaleString()}</span>}
        <span>{formatDur(result?.duration ?? task.duration ?? 0)}</span>
        {result?.language && <span>{result.language}</span>}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-[10px] border border-err/30 bg-err-soft px-3.5 py-2.5 text-err text-[12.5px] mb-3">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {failure && (
        <div className="flex items-start gap-2 rounded-[10px] border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-warn text-[12.5px] mb-3">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="break-words">
            {failure}
            {result?.hint ? <>（{result.hint}）</> : null}
          </span>
        </div>
      )}

      {text ? (
        <div
          className="max-h-[46vh] overflow-y-auto whitespace-pre-wrap break-words text-fg text-[13.5px] leading-relaxed rounded-[10px] border border-border bg-surface-2 p-3.5 select-text"
          tabIndex={0}
        >
          {text}
        </div>
      ) : (
        !error && (
          <p className="text-muted-2">
            这段录音没有留下可用的识别文本{failure ? '' : '（上游未返回任何结果）'}。
          </p>
        )
      )}

      <p className="text-[11.5px] text-muted-2 mt-3">
        实时录音按整段文本归档，上游帧不带句级时间戳，因此没有分片列表和字幕文件。
      </p>
    </Dialog>
  );
};
