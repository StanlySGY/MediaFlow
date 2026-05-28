import { useEffect, useRef } from 'react';

export function useEventSource(
  url: string | null,
  listeners: { [event: string]: (e: MessageEvent) => void },
  onError?: (e: Event) => void
) {
  // Use refs to avoid re-triggering the useEffect subscription when handlers change
  const listenersRef = useRef(listeners);
  listenersRef.current = listeners;
  
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);

    // Add all event type listeners
    const activeListeners = Object.entries(listenersRef.current).map(([evtType, handler]) => {
      const wrappedHandler = (e: MessageEvent) => {
        // Retrieve the freshest handler reference
        if (listenersRef.current[evtType]) {
          listenersRef.current[evtType](e);
        }
      };
      es.addEventListener(evtType, wrappedHandler);
      return { evtType, wrappedHandler };
    });

    es.onerror = (e) => {
      if (onErrorRef.current) {
        onErrorRef.current(e);
      }
    };

    return () => {
      // Remove all event listeners and close EventSource on cleanup
      activeListeners.forEach(({ evtType, wrappedHandler }) => {
        es.removeEventListener(evtType, wrappedHandler);
      });
      es.close();
    };
  }, [url]);
}
