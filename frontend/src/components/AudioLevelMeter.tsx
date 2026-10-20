import React, { useEffect, useRef } from 'react';

interface AudioLevelMeterProps {
  /** The live microphone stream, or null when nothing is open. */
  stream: MediaStream | null;
  /** True while the recorder is actually running. */
  active: boolean;
  /**
   * Peak level of the last sampling window, 0-1. Throttled to ~4Hz: callers
   * use it to say "the microphone is silent", which needs a human-scale
   * reaction time, not every frame.
   */
  onLevel?: (level: number) => void;
  className?: string;
}

const BAR_COUNT = 36;
// Frequency bins run from bass to treble; the first few carry room rumble and
// the top half of a 256-point FFT is empty for speech, so the meter samples the
// speech band instead of spreading all 128 bins across 36 bars.
const LOW_BIN = 2;
const HIGH_BIN = 48;

/**
 * Live input level for the recorder.
 *
 * This is the one piece of feedback a recording UI cannot do without: without
 * it a muted or wrong-input microphone looks exactly like a working one until
 * the recording is over and the transcript comes back empty. It reads the
 * analyser off the *same* stream MediaRecorder is encoding, so what it shows is
 * what is being sent — not a second capture path that could differ.
 *
 * Bars are updated imperatively in the animation frame; routing 60fps of levels
 * through React state would re-render the whole panel with every frame.
 */
export const AudioLevelMeter: React.FC<AudioLevelMeterProps> = ({ stream, active, onLevel, className }) => {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Held in a ref so a new callback identity does not tear down and rebuild
  // the AudioContext (and with it the meter) on every parent render.
  const onLevelRef = useRef(onLevel);
  useEffect(() => {
    onLevelRef.current = onLevel;
  }, [onLevel]);

  useEffect(() => {
    if (!active || !stream || typeof AudioContext === 'undefined') return;
    let audio: AudioContext;
    let source: MediaStreamAudioSourceNode;
    let analyser: AnalyserNode;
    try {
      audio = new AudioContext();
      source = audio.createMediaStreamSource(stream);
      analyser = audio.createAnalyser();
    } catch {
      // A browser that refuses the context simply gets the static baseline.
      return;
    }
    // The context is created inside the click that started the recording, but
    // an `await getUserMedia` can move it out of the gesture window.
    void audio.resume?.().catch(() => undefined);

    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let lastReport = 0;

    const draw = () => {
      frame = window.requestAnimationFrame(draw);
      analyser.getByteFrequencyData(bins);
      const span = Math.max(1, Math.min(HIGH_BIN, bins.length) - LOW_BIN);
      let loudest = 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        const from = LOW_BIN + Math.floor((i * span) / BAR_COUNT);
        const to = LOW_BIN + Math.floor(((i + 1) * span) / BAR_COUNT);
        let peak = 0;
        for (let b = from; b < Math.max(to, from + 1); b++) {
          if (bins[b] > peak) peak = bins[b];
        }
        // 0-255 → a bar that never fully collapses (2px) and never spans the
        // whole track at moderate speech, so the top of the range stays mean-
        // ingful the way a peak meter's headroom does.
        if (peak > loudest) loudest = peak;
        const pct = Math.min(1, (peak / 255) * 1.6);
        const bar = barRefs.current[i];
        if (bar) bar.style.height = `${Math.max(2, Math.round(pct * 32))}px`;
      }
      const now = Date.now();
      if (onLevelRef.current && now - lastReport >= 250) {
        lastReport = now;
        onLevelRef.current(Math.min(1, (loudest / 255) * 1.6));
      }
    };
    frame = window.requestAnimationFrame(draw);

    const bars = barRefs.current;
    return () => {
      window.cancelAnimationFrame(frame);
      for (const bar of bars) {
        if (bar) bar.style.height = '2px';
      }
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* already torn down with the stream */
      }
      void audio.close?.().catch(() => undefined);
    };
  }, [stream, active]);

  return (
    <div
      className={`flex items-end gap-[2px] h-8 ${className || ''}`}
      // The level is redundant with the transcript and the status badge for a
      // screen reader; the pixels are for people watching silence.
      aria-hidden="true"
      data-testid="audio-level-meter"
    >
      {Array.from({ length: BAR_COUNT }).map((_, idx) => (
        <div
          key={idx}
          ref={(node) => { barRefs.current[idx] = node; }}
          className={`flex-1 min-w-[2px] rounded-sm transition-colors duration-150 ${
            active ? 'bg-accent' : 'bg-border-strong'
          }`}
          style={{ height: 2 }}
        />
      ))}
    </div>
  );
};
