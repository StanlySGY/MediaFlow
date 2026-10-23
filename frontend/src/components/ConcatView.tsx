import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Combine, UploadCloud, X, ArrowUp, ArrowDown, Download, Loader2 } from 'lucide-react';
import { formatSize } from '../lib/uploadPreflight';

// Concat has no fetch path left: a whole-file POST that reports progress is an
// XHR, and the authedFetch wrapper cannot report progress, so this view reads
// the token itself and takes no props.
const ext = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
};

export const ConcatView: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; size: number; url: string } | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  // Merge runs in two stages the user cannot tell apart from a spinner: the
  // browser is still pushing bytes, then the server is inside FFmpeg. Upload
  // percentage covers the first; after it hits 100 the label has to say which
  // side is working, because a multi-GB concat sits in stage two for minutes.
  const [uploadProgress, setUploadProgress] = useState(0);
  const [serverWorking, setServerWorking] = useState(false);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // An in-flight XHR outliving the view keeps pushing bytes for a request
  // nobody is watching, and it holds the session's bandwidth.
  useEffect(() => () => xhrRef.current?.abort(), []);

  const exts = new Set(files.map(f => ext(f.name)));
  const mixedFormat = exts.size > 1;
  const canMerge = files.length >= 2 && !mixedFormat && !merging;

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    setError(null);
    setFiles(prev => [...prev, ...Array.from(incoming)]);
  }, []);

  const removeAt = (idx: number) => setFiles(prev => prev.filter((_, i) => i !== idx));

  const move = (idx: number, dir: -1 | 1) => setFiles(prev => {
    const j = idx + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });

  const clearAll = () => {
    xhrRef.current?.abort();
    if (result) URL.revokeObjectURL(result.url);
    setFiles([]);
    setError(null);
    setResult(null);
    setMerging(false);
    setUploadProgress(0);
    setServerWorking(false);
  };

  const cancelMerge = () => xhrRef.current?.abort();

  /** Concat is a whole-file POST, so it gets the same treatment as an upload:
   *  XHR for real progress events, and the token read the way authedFetch
   *  reads it (authedFetch itself cannot report progress). */
  const handleMerge = () => {
    if (!canMerge) return;
    setMerging(true);
    setServerWorking(false);
    setUploadProgress(0);
    setError(null);
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);

    const fd = new FormData();
    files.forEach(f => fd.append('files', f));

    let tok = '';
    try { tok = localStorage.getItem('asr_token') || ''; }
    catch { /* Continue without a token if browser storage is unavailable. */ }

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', '/media/concat');
    if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
    // Merged output can be several GB; a blob download is fine, a timeout is not.
    xhr.responseType = 'blob';

    xhr.upload.onprogress = (e) => {
      if (xhrRef.current !== xhr) return;
      if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => {
      if (xhrRef.current !== xhr) return;
      setUploadProgress(100);
      // Bytes are gone from this machine; the remaining wait is FFmpeg's.
      setServerWorking(true);
    };
    const finish = () => { if (xhrRef.current === xhr) xhrRef.current = null; };

    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        setResult({ name: `merged${ext(files[0].name)}`, size: xhr.response?.size ?? 0, url: URL.createObjectURL(xhr.response as Blob) });
      } else {
        // The failure body is text; the response type is blob, so read it back.
        void Promise.resolve(xhr.response instanceof Blob ? xhr.response.text() : String(xhr.responseText || ''))
          .then((body) => {
            let detail: string;
            try { detail = String(JSON.parse(body).detail || ''); } catch { detail = body.slice(0, 300); }
            setError(detail || `合并失败（HTTP ${xhr.status}）`);
          })
          .catch(() => setError(`合并失败（HTTP ${xhr.status}）`));
      }
      setMerging(false);
      setServerWorking(false);
    };
    xhr.onerror = () => {
      finish();
      setError('网络错误，合并未完成');
      setMerging(false);
      setServerWorking(false);
    };
    xhr.onabort = () => {
      finish();
      setError('已取消合并');
      setMerging(false);
      setServerWorking(false);
    };
    xhr.send(fd);
  };

  const mergeStageText = serverWorking
    ? '服务端正在拼接（不重新编码）…'
    : uploadProgress >= 100
      ? '上传完成，等待服务端开始…'
      : `上传中 ${uploadProgress}%`;

  return (
    <div className="flex flex-col gap-6">
      <div className="card p-4 sm:p-6">
        <p className="hint mb-5">
          选两个以上同一格式的文件（都为 .mp3 或都为 .mp4），按列表顺序无损拼接：stream copy，
          不重新编码。不同格式无法合并。
        </p>

        {/* multi-file picker */}
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept="audio/*,video/*,.pcm"
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
        />
        <motion.div
          role="button"
          tabIndex={0}
          aria-label="选择或拖拽多个音视频文件"
          onDragEnter={(e: React.DragEvent) => { e.preventDefault(); setIsDragActive(true); }}
          onDragOver={(e: React.DragEvent) => { e.preventDefault(); setIsDragActive(true); }}
          onDragLeave={(e: React.DragEvent) => { e.preventDefault(); setIsDragActive(false); }}
          onDrop={(e: React.DragEvent) => { e.preventDefault(); setIsDragActive(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          className={`border border-dashed rounded-[10px] px-6 py-7 text-center cursor-pointer transition-colors duration-150 flex flex-col items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isDragActive
              ? 'border-accent bg-accent-soft'
              : 'border-border-strong bg-surface-2 hover:border-border-strong'
          }`}
        >
          <UploadCloud className={`w-5 h-5 ${isDragActive ? 'text-accent' : 'text-muted-2'}`} />
          <span className="text-base font-medium text-fg">点击选择，或把多个文件拖到这里</span>
          <span className="text-meta text-muted">可多次添加；合并顺序即列表顺序</span>
        </motion.div>

        {/* file list */}
        {files.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {files.map((f, i) => (
              <div key={`${f.name}-${f.size}-${i}`} className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-surface-2">
                <span className="font-mono text-meta text-muted-2 w-4 shrink-0 text-right tabular-nums">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate text-base text-fg" title={f.name}>{f.name}</span>
                <span className="text-meta text-muted shrink-0 tabular-nums">{formatSize(f.size)}</span>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1.5" aria-label="上移"><ArrowUp className="w-3.5 h-3.5" /></button>
                  <button onClick={() => move(i, 1)} disabled={i === files.length - 1} className="p-1.5" aria-label="下移"><ArrowDown className="w-3.5 h-3.5" /></button>
                  <button onClick={() => removeAt(i)} className="danger p-1.5" aria-label="移除"><X className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        )}

        {mixedFormat && (
          <p className="toast err mt-3" role="alert">所选文件格式不一致（{[...exts].join(' / ')}）—— 只能合并同一种格式。</p>
        )}

        {/* actions */}
        <div className="flex gap-2.5 flex-wrap mt-5 items-center">
          <button onClick={handleMerge} disabled={!canMerge} className="primary">
            {merging ? <Loader2 className="w-4 h-4 animate-spin" /> : <Combine className="w-4 h-4" />}
            <span>{merging ? '合并中…' : `开始合并${files.length >= 2 ? `（${files.length} 个）` : ''}`}</span>
          </button>
          {merging && (
            <button onClick={cancelMerge}>
              <X className="w-4 h-4" /><span>取消</span>
            </button>
          )}
          {files.length > 0 && (
            <button onClick={clearAll} disabled={merging}>
              <X className="w-4 h-4" /><span>清空</span>
            </button>
          )}
          <span className="text-meta text-muted tabular-nums">
            合计 {files.map(f => f.size).reduce((a, b) => a + b, 0) ? formatSize(files.map(f => f.size).reduce((a, b) => a + b, 0)) : '0 B'} · {mergeStageText}
          </span>
          {error && <span className="toast err min-w-0 break-words" role="alert">{error}</span>}
        </div>

        {merging && (
          <div className="mt-3">
            <div className="progress" role="progressbar" aria-label="文件上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress}>
              <div style={{ width: `${uploadProgress}%` }} />
            </div>
            {/* FFmpeg's own progress is not reportable over this endpoint, so
                say plainly that the remaining wait is on the server. */}
            {serverWorking && (
              <p className="text-meta text-muted mt-2" role="status">
                文件已全部送达服务端，正在按顺序拼接。大文件需要几分钟，不要关闭页面。
              </p>
            )}
          </div>
        )}
      </div>

      {/* result */}
      {result && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-4 sm:p-6">
          <h3 className="section-title mb-4"><span>合并完成</span></h3>
          {/\.(mp4|webm|mkv|mov|avi)$/i.test(result.name) ? (
            <video controls src={result.url} className="w-full max-h-80 rounded-[10px] bg-black mb-4" />
          ) : (
            <audio controls src={result.url} className="w-full mb-4" />
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-fg font-medium truncate">{result.name}</span>
            <span className="text-sm text-muted tabular-nums">{formatSize(result.size)}</span>
            <button
              onClick={() => { const a = document.createElement('a'); a.href = result.url; a.download = result.name; a.click(); }}
              className="primary ml-auto"
            >
              <Download className="w-4 h-4" /><span>下载</span>
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
};
