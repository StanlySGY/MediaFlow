import React, { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Combine, UploadCloud, X, ArrowUp, ArrowDown, Download, Loader2 } from 'lucide-react';
import { errorMessage } from '../lib/errors';

interface ConcatViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
}

const ext = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
};

export const ConcatView: React.FC<ConcatViewProps> = ({ authedFetch }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; size: number; url: string } | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (result) URL.revokeObjectURL(result.url);
    setFiles([]);
    setError(null);
    setResult(null);
  };

  const handleMerge = async () => {
    if (!canMerge) return;
    setMerging(true);
    setError(null);
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      const r = await authedFetch('/media/concat', { method: 'POST', body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || `合并失败（HTTP ${r.status}）`);
      }
      const blob = await r.blob();
      setResult({ name: `merged${ext(files[0].name)}`, size: blob.size, url: URL.createObjectURL(blob) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="card p-6">
        <h3 className="section-title mb-1">
          <Combine className="w-5 h-5 text-accent" />
          <span>音视频合并</span>
          <span className="section-sub">多个同格式文件按顺序无损拼接</span>
        </h3>
        <p className="hint mb-5">
          选 2 个以上<strong className="text-fg-dim"> 同一格式 </strong>的文件（例如都为 .mp3 或都为 .mp4），
          按下方列表顺序无损合并（stream copy，不重新编码、不损画质音质）。不同格式无法合并。
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
          className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all flex flex-col items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isDragActive
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-border-strong bg-surface-2 hover:border-accent/50 text-fg-dim'
          }`}
          whileHover={{ scale: 1.005 }}
          whileTap={{ scale: 0.995 }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center bg-accent-soft text-accent">
            <UploadCloud className="w-5 h-5" />
          </div>
          <strong className="text-fg text-sm font-semibold">点击选择，或把多个文件拖到这里</strong>
          <small className="text-[11.5px] text-muted">可多次添加；合并顺序 = 列表顺序，可在下方调整</small>
        </motion.div>

        {/* file list */}
        {files.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {files.map((f, i) => (
              <div key={`${f.name}-${f.size}-${i}`} className="flex items-center gap-3 p-2.5 rounded-xl border border-border bg-surface-2">
                <span className="badge font-mono shrink-0">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate text-[13px] text-fg" title={f.name}>{f.name}</span>
                <span className="text-[11px] text-muted font-mono shrink-0">{formatBytes(f.size)}</span>
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
          <p className="toast err mt-3">所选文件格式不一致（{[...exts].join(' / ')}）—— 只能合并同一种格式。</p>
        )}

        {/* actions */}
        <div className="flex gap-2.5 flex-wrap mt-5 items-center">
          <button onClick={handleMerge} disabled={!canMerge} className="primary">
            {merging ? <Loader2 className="w-4 h-4 animate-spin" /> : <Combine className="w-4 h-4" />}
            <span>{merging ? '合并中…' : `开始合并${files.length >= 2 ? `（${files.length} 个）` : ''}`}</span>
          </button>
          {files.length > 0 && (
            <button onClick={clearAll} disabled={merging}>
              <X className="w-4 h-4" /><span>清空</span>
            </button>
          )}
          {error && <span className="toast err">✗ {error}</span>}
        </div>
      </div>

      {/* result */}
      {result && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-6">
          <h3 className="section-title mb-4"><span>合并完成</span></h3>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="badge ok"><span className="dot" />已生成</span>
            <span className="text-[13px] text-fg font-mono truncate">{result.name}</span>
            <span className="text-[11px] text-muted font-mono">{formatBytes(result.size)}</span>
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
