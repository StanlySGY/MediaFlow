/**
 * The provider / split-strategy vocabulary the backend accepts, spelled out in
 * the words an operator uses.
 *
 * These enums arrive from the server as raw identifiers (`realtime_ws`,
 * `silence`, `openai_compat`). Showing them verbatim asks every reader to
 * already know the config file — which is the thing the 服务配置 page exists to
 * avoid. One table per enum, shared by 服务配置, the sidebar footer and the
 * realtime panel header, so the three surfaces cannot describe the same value
 * three different ways.
 *
 * Keep in sync with `app/config.py` (provider, split_strategy,
 * realtime_asr_provider), `app/services/asr/realtime_registry.py` (which
 * realtime providers exist) and what `/asr/config` reports in
 * `available_providers` / `available_realtime_providers`.
 */

export const PROVIDER_LABELS: Record<string, string> = {
  openai_compat: '标准语音接口（兼容 Whisper / OpenAI）',
  openai_chat_audio: '对话式语音接口（Qwen3-ASR 等）',
};

export const SPLIT_LABELS: Record<string, string> = {
  silence: '按静音切分（推荐）',
  fixed: '固定时长切分',
  overlap: '重叠切分',
};

export const REALTIME_LABELS: Record<string, string> = {
  realtime_ws: 'WebSocket 直连（边说边出字）',
  realtime_http: 'HTTP 流式（边说边出字）',
  realtime_offline: '录完再识别',
  realtime_mock: '演示数据（不调用真实服务）',
};

/** Label for an enum value, falling back to the raw value: an unknown provider
 *  must still be visible, just not pretending to be explained. */
export const enumLabel = (table: Record<string, string>, value?: string | null): string =>
  !value ? '' : table[value] ?? value;

/** One-line explanation of what a realtime provider actually does to the audio,
 *  shown wherever a recording is happening. */
/** The providers whose behaviour surprises someone mid-recording, explained
 *  once for the whole session instead of only in a first-run guide that
 *  disappears after the first config edit. Empty for the streaming providers,
 *  where the header note already describes what the user sees happening. */
export const realtimeProviderGuide = (provider?: string | null): string => {
  switch (provider) {
    case 'realtime_mock':
      return '当前是演示 provider：文字由服务端伪造，不调用任何 ASR 服务。要识别真实语音，请在「服务配置」把实时 provider 改成 realtime_ws 或 realtime_http。';
    case 'realtime_offline':
      return '当前 provider 不在录音过程中出字：音频先完整送达服务端，停止录音后再一次性识别。等待期间文稿不动是正常的。';
    default:
      return '';
  }
};

export const realtimeProviderNote = (provider?: string | null): string => {
  switch (provider) {
    case 'realtime_mock':
      return '演示模式 · 不调用真实 ASR';
    case 'realtime_offline':
      return '录完再识别 · 停止录音后一次性出字';
    case 'realtime_ws':
      return 'WebSocket 直连 · 边说边出字';
    case 'realtime_http':
      return 'HTTP 流式 · 边说边出字';
    default:
      return provider || '';
  }
};
