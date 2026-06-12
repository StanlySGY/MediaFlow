import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorView } from './MonitorView';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const baseSnapshot = {
  summary: {
    total: 1,
    running: 0,
    succeeded: 1,
    failed: 0,
    avg_elapsed_ms: 318.4,
    window_size: 200,
  },
  config: {
    provider: 'openai_chat_audio',
    model: 'qwen3-asr-flash',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_key_set: true,
    realtime_asr_provider: 'realtime_offline',
  },
  calls: [
    {
      call_id: 'call-ok',
      provider: 'openai_chat_audio',
      model: 'qwen3-asr-flash',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      status: 'ok',
      source: 'file_task',
      task_id: 'task-123',
      session_id: null,
      segment_id: 1,
      request_bytes: 2048,
      text_chars: 8,
      error: null,
      started_at: 1791770000,
      ended_at: 1791770001,
      elapsed_ms: 318.4,
    },
  ],
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  onerror: (() => void) | null = null;
  closed = false;

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

  close() {
    this.closed = true;
  }
}

describe('<MonitorView />', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('renders the ASR monitor snapshot and updates from SSE events', async () => {
    const authedFetch = vi.fn(async () => json(baseSnapshot));

    render(
      <MonitorView
        authedFetch={authedFetch}
        sseUrl={(path) => `${path}?token=t`}
      />,
    );

    expect(await screen.findByText('上游调用监控')).toBeInTheDocument();
    expect(screen.getByText('qwen3-asr-flash')).toBeInTheDocument();
    expect(screen.getByText('task-123')).toBeInTheDocument();
    expect(screen.getByText('1 / 200')).toBeInTheDocument();
    expect(MockEventSource.instances[0].url).toBe('/asr/monitor/events?token=t');

    act(() => {
      MockEventSource.instances[0].emit('call_finished', {
        type: 'call_finished',
        call: {
          ...baseSnapshot.calls[0],
          call_id: 'call-error',
          status: 'error',
          source: 'realtime_offline',
          task_id: null,
          session_id: 'sess-9',
          segment_id: null,
          request_bytes: 4096,
          text_chars: 0,
          error: 'upstream 500',
          elapsed_ms: 902.1,
        },
      });
    });

    expect(await screen.findByText('sess-9')).toBeInTheDocument();
    expect(screen.getByText('upstream 500')).toBeInTheDocument();
    expect(screen.getByText('2 / 200')).toBeInTheDocument();
  });
});
