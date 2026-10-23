import { vi } from 'vitest';

/**
 * Test harness shared by the two realtime surfaces.
 *
 * The recorder view and the manual-session (接口调试) view talk to the same
 * endpoints and the same SSE contract, so both need EventSource / MediaRecorder
 * doubles that behave identically. Keeping them here stops the two suites from
 * drifting apart on details that are actually the server's contract.
 */

export const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

export class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, handler: (event: MessageEvent) => void) {
    this.listeners[event] = [...(this.listeners[event] || []), handler];
  }

  emit(event: string, data: unknown) {
    for (const handler of this.listeners[event] || []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  emitOpen() {
    this.onopen?.();
  }

  emitError() {
    this.onerror?.();
  }

  close() {
    this.closeCalls += 1;
  }
}

/** One incremental text event under the splice contract the server emits. */
export const textDeltaEvent = (
  sessionId: string,
  start: number,
  text: string,
  remove = 0,
  elapsedMs?: number,
  // Whether this frame is upstream's "this sentence is settled" frame. It cannot
  // be inferred from `start`: an online frame appends too. The cue tracker cuts
  // only on this one, so a test has to say which frame it is.
  final = start > 0,
) => ({
  type: 'text',
  stream: 'realtime',
  id: sessionId,
  session_id: sessionId,
  text: '',
  delta: { start, remove, text },
  is_final: final,
  source_event: final ? 'final' : 'online',
  // The server counts elapsed_ms from session creation; a test that cares about
  // subtitle timing sets it instead of relying on the wall clock.
  ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
});

/**
 * AudioContext double. jsdom has none, so a component that attaches an
 * analyser to the microphone stream would otherwise throw on every mount.
 * `level` is what every reported frequency bin reads, so a test can say
 * "there is sound" or "the room is silent" and the component must agree.
 */
export class MockAudioContext {
  static instances: MockAudioContext[] = [];
  level = 0;
  state = 'running';
  fftSize = 2048;
  smoothingTimeConstant = 0;
  closed = false;
  readonly frequencyBinCount = 128;

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createAnalyser() {
    return {
      fftSize: 2048,
      smoothingTimeConstant: 0,
      frequencyBinCount: 128,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteFrequencyData: (bins: Uint8Array) => bins.fill(this.level),
    };
  }

  resume() {
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

export class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn((mime: string) => mime.startsWith('audio/webm'));
  state = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(public stream: MediaStream, public options?: MediaRecorderOptions) {
    MockMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

/**
 * Install the doubles. `media` is false for the debug view, which never opens a
 * microphone — leaving getUserMedia undefined makes an accidental recorder
 * mount fail loudly instead of passing quietly.
 */
export const installRealtimeMocks = (opts: { media?: boolean } = {}) => {
  MockEventSource.instances = [];
  MockMediaRecorder.instances = [];
  MockAudioContext.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('AudioContext', MockAudioContext);
  if (opts.media !== false) {
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  }
};

export const stubClipboard = () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
};
