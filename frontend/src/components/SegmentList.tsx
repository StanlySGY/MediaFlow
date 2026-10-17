import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, ChevronDown, Copy, Play } from 'lucide-react';
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

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${sec.padStart(4, '0')}`;
};

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
  const editable = sortedSegments.filter((s) => s.is_final && !s.error).length;

  return (
    <div className="flex flex-col gap-2">
      {onEditText && editable > 0 && (
        <p className="hint">双击文本可就地校对；校对后在「完整文本」导出精修字幕。</p>
      )}

      <div className="rounded-[10px] border border-border bg-surface overflow-hidden divide-y divide-border">
        {sortedSegments.map((seg) => {
          const isExpanded = expandedSegId === seg.segment_id;
          const isLoading = loadingId === seg.segment_id;
          const elapsed = seg.elapsed_ms ? `${seg.elapsed_ms.toFixed(0)}ms` : null;
          const canEdit = !!onEditText && seg.is_final && !seg.error;
          const isEditing = editingId === seg.segment_id;

          return (
            <div key={seg.segment_id} className="group/seg">
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onClick={() => !isEditing && toggleExpand(seg.segment_id)}
                onKeyDown={(e) => {
                  if (isEditing) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void toggleExpand(seg.segment_id);
                  }
                }}
                className="flex items-start gap-3 px-4 py-3 cursor-pointer select-none outline-none focus-visible:bg-surface-2 hover:bg-surface-2 transition-colors"
              >
                <span className="font-mono text-meta text-muted-2 w-6 shrink-0 pt-1 tabular-nums text-right">
                  {seg.segment_id}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 text-meta text-muted mb-1">
                    <span className="font-mono tabular-nums">
                      {formatTime(seg.start)} – {formatTime(seg.end)}
                    </span>
                    {seg.speaker && (
                      <span className="px-1.5 py-0.5 rounded border border-border bg-surface-2 text-fg-dim">
                        {seg.speaker}
                      </span>
                    )}
                    {elapsed && <span className="text-muted-2">{elapsed}</span>}
                    {seg.error && (
                      <span className="inline-flex items-center gap-1 text-err">
                        <AlertTriangle className="w-3 h-3" />
                        识别失败
                      </span>
                    )}
                  </div>

                  {seg.error ? (
                    <p className="text-sm text-err leading-relaxed break-words">{seg.error}</p>
                  ) : isEditing ? (
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          commitEdit(seg.segment_id);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => commitEdit(seg.segment_id)}
                      className="w-full bg-surface border border-accent/40 rounded-[8px] px-3 py-2 text-base leading-relaxed text-fg outline-none resize-y select-text"
                    />
                  ) : (
                    <p
                      onDoubleClick={canEdit ? (e) => { e.stopPropagation(); startEdit(seg); } : undefined}
                      title={canEdit ? '双击校对这段文本' : undefined}
                      className={`text-base leading-relaxed break-words ${
                        seg.text ? 'text-fg' : 'text-muted-2'
                      }`}
                    >
                      {seg.text || '识别中…'}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0 pt-0.5">
                  {onSeek && !seg.error && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onSeek(seg.start); }}
                      title="跳到此处播放"
                      aria-label={`播放第 ${seg.segment_id} 段`}
                      className="w-7 h-7 p-0 border-0 bg-transparent text-muted opacity-0 group-hover/seg:opacity-100 focus-visible:opacity-100 hover:text-accent transition-opacity"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <ChevronDown
                    className={`w-4 h-4 text-muted-2 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  />
                </div>
              </div>

              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-border bg-surface-2 px-4 py-3">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <span className="text-meta text-muted">上游原始返回</span>
                        {rawData[seg.segment_id] && !isLoading && (
                          <button
                            onClick={() => copyRaw(seg.segment_id)}
                            className="text-meta py-0.5 px-2"
                          >
                            {copiedId === seg.segment_id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                            <span>{copiedId === seg.segment_id ? '已复制' : '复制'}</span>
                          </button>
                        )}
                      </div>

                      {isLoading ? (
                        <div className="text-meta text-muted py-2">正在加载…</div>
                      ) : (
                        /* Dark inset: the syntax palette below is tuned for it. */
                        <pre
                          className="text-meta font-mono overflow-auto max-h-[280px] leading-relaxed rounded-[8px] bg-[#0e1626] border border-[#1d2740] px-3 py-2.5 text-[#cdd6e6]"
                          dangerouslySetInnerHTML={{ __html: highlightJson(rawData[seg.segment_id] || '无返回数据') }}
                        />
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
};
