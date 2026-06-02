import { useEffect, useRef } from 'react';

export function useEventSource(
  url: string | null,
  listeners: { [event: string]: (e: MessageEvent) => void },
  onError?: (e: Event) => void
) {
  // Keep the latest handlers in refs so the subscription effect (keyed on url)
  // doesn't tear down and rebuild when handler identities change.
  const listenersRef = useRef(listeners);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    listenersRef.current = listeners;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);

    // Add all event type listeners
    const activeListeners = Object.keys(listenersRef.current).map((evtType) => {
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
