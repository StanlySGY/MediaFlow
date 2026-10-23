import { SubtitleCue } from './subtitle';

/**
 * Subtitle cues for a realtime recording.
 *
 * The server deliberately archives a realtime session with `segments: []`: the
 * upstream frames carry no utterance timestamps, and any start/end written
 * there would be invented rather than measured (see
 * `RealtimeManager._archive_record`). What *is* measured is this client's own
 * clock: every session starts at 0 and every SSE event carries `elapsed_ms`
 * counted from that start.
 *
 * So the cues here are measured, not guessed — but they are measured from the
 * recording, not from the audio:
 *   - a cue closes at each upstream sentence boundary (`source_event: 'final'`),
 *     which is the upstream's own decision about where a sentence ended;
 *   - the last cue runs from the last boundary to the moment the session ended.
 * A provider that never reports a boundary (realtime_offline decodes the whole
 * recording at the end) therefore yields exactly one cue for the whole session,
 * which is the honest answer, not a fabricated set of cuts.
 */

/** Char offset + measured time of one closed boundary. */
interface Boundary {
  /** Length of the transcript when the boundary closed (UTF-16 units). */
  chars: number;
  /** Seconds from the start of the session. */
  seconds: number;
}

export interface RealtimeCueTracker {
  /** Record that a sentence boundary closed at this event. */
  closeBoundary: (textLength: number, elapsedMs: number | undefined) => void;
  /** Read the cues for the transcript as it stands now. `text` is the full
   *  committed transcript; `elapsedMs` is how long the session has run. Cue text
   *  is trimmed, so what this returns is what the export contains. */
  cues: (text: string, elapsedMs: number) => SubtitleCue[];
  /** How many boundaries have closed. Zero means the export is one cue for the
   *  whole session, and the UI has to say so. */
  boundaryCount: () => number;
  reset: () => void;
}

export const createRealtimeCueTracker = (): RealtimeCueTracker => {
  const boundaries: Boundary[] = [];
  // Where the still-open cue starts. Starts at the beginning of the session.
  let open: Boundary = { chars: 0, seconds: 0 };

  return {
    closeBoundary: (textLength, elapsedMs) => {
      // Never go backwards: an upstream that restarts its own clock would
      // otherwise produce a cue that ends before it starts.
      const seconds = Math.max(open.seconds, (elapsedMs ?? open.seconds * 1000) / 1000);
      boundaries.push({ chars: Math.max(0, textLength), seconds });
      open = { chars: Math.max(0, textLength), seconds };
    },
    cues: (text, elapsedMs) => {
      const cues: SubtitleCue[] = [];
      let prev: Boundary = { chars: 0, seconds: 0 };
      for (const b of boundaries) {
        const start = Math.min(prev.chars, text.length);
        const end = Math.min(Math.max(b.chars, start), text.length);
        const cueText = text.slice(start, end).trim();
        if (!cueText) {
          // An upstream "final" can restate text that is already there
          // (realtime_ws sends the whole cumulative text per frame), so a
          // boundary may close with nothing new. The measured time is still the
          // moment that sentence ended: keep the offset so no text is skipped,
          // advance the clock, and stretch the cue before it to this instant.
          if (cues.length) {
            const last = cues[cues.length - 1];
            last.end = Math.max(last.end, b.seconds);
          }
          prev = { chars: prev.chars, seconds: Math.max(prev.seconds, b.seconds) };
          continue;
        }
        cues.push({ start: prev.seconds, end: Math.max(b.seconds, prev.seconds), text: cueText });
        prev = { chars: end, seconds: Math.max(b.seconds, prev.seconds) };
      }
      // The tail: text produced since the last boundary, timed to now.
      const tailStart = Math.min(Math.max(prev.chars, 0), text.length);
      const tail = text.slice(tailStart).trim();
      if (tail) {
        cues.push({ start: prev.seconds, end: Math.max(elapsedMs / 1000, prev.seconds), text: tail });
      }
      return cues;
    },
    boundaryCount: () => boundaries.length,
    reset: () => {
      boundaries.length = 0;
      open = { chars: 0, seconds: 0 };
    },
  };
};
