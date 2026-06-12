export interface ASRSegment {
  segment_id: number;
  start: number;
  end: number;
  text: string;
  is_final: boolean;
  elapsed_ms?: number;
  error?: string | null;
}

export interface ASRTask {
  task_id: string;
  status: string;
  duration?: number;
  language?: string;
  text?: string;
  segments: ASRSegment[];
  total_segments: number;
  finished_segments: number;
  progress: number;
}

export interface RealtimeSession {
  session_id: string;
  status: string;
  sample_rate: number;
  format: string;
  channels: number;
  mode: string;
  hotwords: string[];
  chunks_received: number;
  bytes_received: number;
}

export interface RealtimeEvent {
  type: 'online' | 'final' | 'done' | 'error';
  session_id: string;
  seq?: number;
  text?: string;
  is_final?: boolean;
  elapsed_ms?: number;
  mode?: string;
  error?: string;
  raw?: unknown;
}

export interface StandardASRStreamEvent {
  type: 'text' | 'done' | 'error';
  stream: 'realtime' | 'file';
  id: string;
  text: string;
  is_final: boolean;
  seq?: number | null;
  session_id?: string | null;
  task_id?: string | null;
  segment_id?: number | null;
  start?: number | null;
  end?: number | null;
  elapsed_ms?: number;
  status?: string | null;
  progress?: number | null;
  error?: string | null;
  source_event?: string | null;
}

export interface SystemConfig {
  provider?: string;
  model?: string;
  base_url?: string;
  api_key_set?: boolean;
  language?: string;
  timestamps?: boolean;
  hotwords?: string;
  prompt_hints?: string;
  concurrency?: number;
  max_retries?: number;
  retry_backoff?: number;
  timeout?: number;
  split_strategy?: string;
  chunk_seconds?: number;
  overlap_seconds?: number;
  silence_noise_db?: number;
  silence_min_duration?: number;
  max_upload_bytes?: number;
  realtime_asr_provider?: string;
  realtime_asr_base_url?: string;
  realtime_asr_api_key?: string;
  realtime_asr_model?: string;
  realtime_api_key_set?: boolean;
  realtime_max_chunk_bytes?: number;
  realtime_session_ttl_seconds?: number;
  realtime_max_sessions?: number;
  access_tokens_count?: number;
  available_providers?: string[];
  [key: string]: unknown;
}
