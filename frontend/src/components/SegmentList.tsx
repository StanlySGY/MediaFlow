import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, Timer, Eye, AlertTriangle, Play, Copy, Check } from 'lucide-react';
import { ASRSegment } from '../types';
import { errorMessage } from '../lib/errors';

interface SegmentListProps {
  segments: ASRSegment[];
  taskId: string | null;
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onSeek?: (start: number) => void;
  onEditText?: (segId: number, text: string) => void;
}

// Minimal, safe JSON syntax highlighter -> HTML string (input is escaped first).
function highlightJson(json: string): string {
  const esc = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'text-[#7fd1a7]'; // number
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'text-[#9cc0ff]' : 'text-[#e0a878]'; // key : string
      } else if (/true|false/.test(match)) {
        cls = 'text-[#c39cff]'; // boolean
      } else if (/null/.test(match)) {
        cls = 'text-[#7a869c]'; // null
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export const SegmentList: React.FC<SegmentListProps> = ({
  segments,
  taskId,
  authedFetch,
  onSeek,
  onEditText,
}) => {
  const [expandedSegId, setExpandedSegId] = useState<number | null>(null);
  const [rawData, setRawData] = useState<{ [id: number]: string }>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const startEdit = (seg: ASRSegment) => {
    setEditingId(seg.segment_id);
    setDraft(seg.text || '');
  };
  const commitEdit = (segId: number) => {
    if (editingId !== segId) return;
    onEditText?.(segId, draft.trim());
    setEditingId(null);
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return `${String(m).padStart(2, '0')}:${sec.padStart(4, '0')}`;
  };

  const toggleExpand = async (segId: number) => {
    if (expandedSegId === segId) {
      setExpandedSegId(null);
      return;
    }
    setExpandedSegId(segId);
    if (rawData[segId] || !taskId) return;

    setLoadingId(segId);
    try {
      const r = await authedFetch(`/asr/task/${taskId}/segments/${segId}/raw`);
      if (r.ok) {
        const data = await r.json();
        setRawData((prev) => ({ ...prev, [segId]: JSON.stringify(data, null, 2) }));
      } else {
        setRawData((prev) => ({ ...prev, [segId]: `加载失败: HTTP ${r.status}` }));
      }
    } catch (e) {
      setRawData((prev) => ({ ...prev, [segId]: `加载失败: ${errorMessage(e)}` }));
    } finally {
      setLoadingId(null);
    }
  };

  const copyRaw = (segId: number) => {
    const raw = rawData[segId];
    if (!raw) return;
    navigator.clipboard.writeText(raw);
    setCopiedId(segId);
    setTimeout(() => setCopiedId((c) => (c === segId ? null : c)), 2000);
  };

  const sortedSegments = [...segments].sort((a, b) => a.segment_id - b.segment_id);

  return (
    <div className="flex flex-col gap-3">
      {onEditText && sortedSegments.some((s) => s.is_final && !s.error) && (
        <p className="hint">双击分片文本即可就地校对；校对后在「完整文本」标签可导出精修后的 SRT/VTT 字幕。</p>
      )}
      <AnimatePresence initial={false}>
        {sortedSegments.map((seg) => {
          const isExpanded = expandedSegId === seg.segment_id;
          const isLoading = loadingId === seg.segment_id;
          const elapsed = seg.elapsed_ms ? `${seg.elapsed_ms.toFixed(0)}ms` : '—';

          return (
            <motion.div
              key={seg.segment_id}
              layout="position"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              className="border border-border rounded-xl bg-white hover:border-accent/30 hover:bg-accent-soft/40 transition-colors overflow-hidden"
            >
              {/* Main content row */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onClick={() => toggleExpand(seg.segment_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(seg.segment_id); }
                }}
                className="flex flex-col md:flex-row md:items-center gap-4 px-5 py-4 cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-xl"
              >
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono text-xs font-bold text-accent">#{seg.segment_id}</span>

                  {onSeek && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onSeek(seg.start); }}
                      title="跳到此处播放"
                      aria-label={`播放第 ${seg.segment_id} 段`}
                      className="w-7 h-7 p-0 rounded-full bg-accent-soft border-accent/20 text-accent flex items-center justify-center hover:bg-accent hover:text-white"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2.5 py-1 rounded-full bg-surface-3 border border-border text-fg-dim">
                    <Clock className="w-3 h-3 text-accent-2" />
                    <span>{formatTime(seg.start)} – {formatTime(seg.end)}</span>
                  </span>

                  <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2.5 py-1 rounded-full bg-surface-3 border border-border text-muted">
                    <Timer className="w-3 h-3 text-muted" />
                    <span>{elapsed}</span>
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  {seg.error ? (
                    <div className="flex items-center gap-1.5 text-err text-[13px] font-medium">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>{seg.error}</span>
                    </div>
                  ) : editingId === seg.segment_id ? (
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(seg.segment_id); }
                        else if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                      }}
                      onBlur={() => commitEdit(seg.segment_id)}
                      className="w-full bg-surface-2 border border-accent/40 rounded-lg px-3 py-2 text-[13.5px] leading-relaxed text-fg outline-none resize-y select-text"
                    />
                  ) : (
                    <p
                      onDoubleClick={onEditText && seg.is_final ? (e) => { e.stopPropagation(); startEdit(seg); } : undefined}
                      title={onEditText && seg.is_final ? '双击校对此分片文本' : undefined}
                      className="text-[13.5px] leading-relaxed text-fg truncate"
                    >
                      {seg.text || '识别中…'}
                    </p>
                  )}
                </div>

                <div className="shrink-0 text-muted">
                  <Eye className="w-4 h-4" />
                </div>
              </div>

              {/* Collapsible raw data panel */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: 'auto' }}
                    exit={{ height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="border-t border-border bg-[#0e1626] p-5">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-[10px] uppercase font-bold tracking-wider text-[#6b7790] font-mono">
                          ASR 接口原始返回（调试用）
                        </span>
                        {rawData[seg.segment_id] && !isLoading && (
                          <button
                            onClick={() => copyRaw(seg.segment_id)}
                            className="text-[11px] py-1 px-2.5 bg-white/5 border-white/10 text-[#9cc0ff] hover:bg-white/10"
                          >
                            {copiedId === seg.segment_id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            <span>{copiedId === seg.segment_id ? '已复制' : '复制'}</span>
                          </button>
                        )}
                      </div>

                      {isLoading ? (
                        <div className="text-xs font-mono text-[#9cc0ff] animate-pulse">正在加载上游返回数据…</div>
                      ) : (
                        <pre
                          className="text-[11px] font-mono overflow-auto max-h-[300px] leading-relaxed text-[#cdd6e6]"
                          dangerouslySetInnerHTML={{ __html: highlightJson(rawData[seg.segment_id] || '无返回数据') }}
                        />
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
