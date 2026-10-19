import React, { useCallback, useRef, useState } from 'react';
import { Dialog } from './Dialog';

export interface ConfirmOptions {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
}

/**
 * In-app replacement for window.confirm().
 *
 * Lives in its own file so Dialog.tsx exports components only (fast refresh).
 *
 * Unlike window.confirm, the caller has to describe what the action destroys —
 * the old prompts ("确认从历史中删除这条记录？") never said the record and its
 * outputs are gone for good, which is the part a user needs before clicking 确认.
 * The caller awaits the result, so the destructive call stays where it was.
 */
export function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolver?.(ok);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // Only one dialog at a time: a newer request cancels the pending one.
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setRequest(options);
      }),
    [],
  );

  const dialog = request ? (
    <Dialog
      title={request.title}
      onClose={() => settle(false)}
      footer={
        <>
          <button data-autofocus onClick={() => settle(false)}>
            取消
          </button>
          <button className="danger" onClick={() => settle(true)}>
            {request.confirmLabel || '确认'}
          </button>
        </>
      }
    >
      {request.message}
    </Dialog>
  ) : null;

  return { confirm, dialog };
}
