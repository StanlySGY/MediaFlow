import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeView } from './RealtimeView';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  onerror: (() => void) | null = null;

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

  close() {}
}

class MockMediaRecorder {
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

describe('<RealtimeView /> browser recorder', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    MockMediaRecorder.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts browser recording and shows realtime text on the white board', async () => {
    const authedFetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/asr/realtime/session') return json({ session_id: 'sess-1' });
      if (url === '/asr/realtime/sess-1') return json({ bytes_received: 128 });
      if (url === '/asr/realtime/sess-1/audio') return json({ ok: true });
      return json({});
    });

    render(<RealtimeView authedFetch={authedFetch} sseUrl={(path) => path} />);

    await userEvent.click(screen.getByRole('button', { name: '开始录音' }));

    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/asr/realtime/sess-1/events');
    const sessionBody = JSON.parse(String(authedFetch.mock.calls[0][1]?.body));
    expect(sessionBody.format).toBe('webm');

    act(() => {
      MockEventSource.instances[0].emit('message', {
        type: 'text',
        stream: 'realtime',
        id: 'sess-1',
        session_id: 'sess-1',
        text: '你好，正在识别。',
        is_final: false,
        source_event: 'online',
      });
    });

    expect(await screen.findByText('你好，正在识别。')).toBeInTheDocument();
    expect(screen.getByText(/"event":"sse"/)).toBeInTheDocument();
  });
});
