import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, Timer, Eye, AlertTriangle } from 'lucide-react';
import { ASRSegment } from '../types';

interface SegmentListProps {
  segments: ASRSegment[];
  taskId: string | null;
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
}

export const SegmentList: React.FC<SegmentListProps> = ({
  segments,
  taskId,
  authedFetch,
}) => {
  const [expandedSegId, setExpandedSegId] = useState<number | null>(null);
  const [rawData, setRawData] = useState<{ [id: number]: string }>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);

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
        setRawData((prev) => ({
          ...prev,
          [segId]: JSON.stringify(data, null, 2),
        }));
      } else {
        setRawData((prev) => ({
          ...prev,
          [segId]: `加载失败: HTTP ${r.status}`,
        }));
      }
    } catch (e: any) {
      setRawData((prev) => ({
        ...prev,
        [segId]: `加载失败: ${e.message}`,
      }));
    } finally {
      setLoadingId(null);
    }
  };

  const sortedSegments = [...segments].sort((a, b) => a.segment_id - b.segment_id);

  return (
    <div className="flex flex-col gap-3">
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
              className="border border-white/5 rounded-xl bg-white/2 hover:bg-[#5c54f2]/3 hover:border-[#5c54f2]/20 transition-colors overflow-hidden"
            >
              {/* Main content row */}
              <div
                onClick={() => toggleExpand(seg.segment_id)}
                className="flex flex-col md:flex-row md:items-center gap-4 px-5 py-4 cursor-pointer select-none"
              >
                {/* ID and Status badge */}
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono text-xs font-bold text-[#5c54f2]">
                    #{seg.segment_id}
                  </span>
                  
                  <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2.5 py-1 rounded-full bg-white/4 border border-white/5 text-gray-300">
                    <Clock className="w-3 h-3 text-[#8b5cf6]" />
                    <span>{formatTime(seg.start)} – {formatTime(seg.end)}</span>
                  </span>
                  
                  <span className="flex items-center gap-1 text-[11px] font-mono font-medium px-2.5 py-1 rounded-full bg-white/4 border border-white/5 text-gray-400">
                    <Timer className="w-3 h-3 text-gray-500" />
                    <span>{elapsed}</span>
                  </span>
                </div>

                {/* Text content */}
                <div className="flex-1 min-w-0">
                  {seg.error ? (
                    <div className="flex items-center gap-1.5 text-[#ef4444] text-[13px] font-medium">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>{seg.error}</span>
                    </div>
                  ) : (
                    <p className="text-[13.5px] leading-relaxed text-gray-200 truncate">
                      {seg.text || '正在转写…'}
                    </p>
                  )}
                </div>

                <div className="shrink-0 text-gray-500 md:opacity-0 hover:opacity-100 group-hover:opacity-100 transition-opacity">
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
                    <div className="border-t border-white/5 bg-[#05070e] p-5 shadow-inner">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-[10px] uppercase font-bold tracking-wider text-gray-500 font-mono">
                          Raw JSON Response payload
                        </span>
                      </div>
                      
                      {isLoading ? (
                        <div className="text-xs font-mono text-[#5c54f2] animate-pulse">
                          正在加载上游响应数据…
                        </div>
                      ) : (
                        <pre className="text-[11px] font-mono text-[#a5b4fc] overflow-auto max-h-[300px] leading-relaxed">
                          {rawData[seg.segment_id] || '无返回数据'}
                        </pre>
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
