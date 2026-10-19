import React, { useEffect, useId, useRef } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

/**
 * Modal shell for the dialogs that replaced window.alert / confirm / prompt.
 *
 * The native versions were the app's only dialog surface, which meant every
 * error, confirmation and credential prompt inherited the browser chrome: no
 * styling, no context about what is about to be lost, no focus management, and
 * a blocking call that freezes the whole page (including any in-flight upload).
 */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind width class. Only dialogs that show content the
   *  user has to read (a transcript) widen past the default 440px prompt width. */
  panelWidth?: string;
}

export const Dialog: React.FC<DialogProps> = ({
  title,
  onClose,
  children,
  footer,
  panelWidth = 'max-w-[440px]',
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const nodes = panelRef.current
      ? Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      : [];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        onKeyDown={trapFocus}
        className={`card relative w-full ${panelWidth} px-5 py-4`}
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="section-title flex-1 min-w-0">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="ghost w-7 h-7 p-0 shrink-0 -mt-0.5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-2 text-sm text-muted leading-relaxed">{children}</div>
        {footer && <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>}
      </motion.div>
    </div>
  );
};
