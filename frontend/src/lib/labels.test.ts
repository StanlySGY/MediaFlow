import { describe, expect, it } from 'vitest';
import { enumLabel, PROVIDER_LABELS, realtimeProviderGuide, REALTIME_LABELS } from './labels';

describe('labels', () => {
  it('names each provider the way the settings screen names it', () => {
    // The four values the realtime registry actually accepts, spelled in the
    // operator's words rather than the config file's.
    expect(Object.keys(REALTIME_LABELS).sort()).toEqual(
      ['realtime_http', 'realtime_mock', 'realtime_offline', 'realtime_ws'],
    );
    expect(enumLabel(REALTIME_LABELS, 'realtime_mock')).toContain('演示');
    expect(enumLabel(REALTIME_LABELS, 'realtime_ws')).toContain('边说边出字');
    expect(enumLabel(PROVIDER_LABELS, 'openai_compat')).toContain('Whisper');
  });

  it('shows an unlisted value rather than hiding it', () => {
    // A provider added on the server before this table is updated must still be
    // visible in the UI, or the operator sees a blank where the setting is.
    expect(enumLabel(REALTIME_LABELS, 'realtime_brand_new')).toBe('realtime_brand_new');
    expect(enumLabel(REALTIME_LABELS, undefined)).toBe('');
  });

  it('explains the providers whose text does not behave as expected mid-recording', () => {
    expect(realtimeProviderGuide('realtime_mock')).toContain('演示 provider');
    expect(realtimeProviderGuide('realtime_offline')).toContain('不在录音过程中出字');
    // The streaming providers need no warning; explaining them every session is noise.
    expect(realtimeProviderGuide('realtime_ws')).toBe('');
    expect(realtimeProviderGuide('realtime_http')).toBe('');
    expect(realtimeProviderGuide(undefined)).toBe('');
  });
});
