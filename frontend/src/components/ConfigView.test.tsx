import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfigView } from './ConfigView';

const jsonResponse = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => data,
}) as Response;

const profilesFixture = (secondProfile = false) => ({
  profiles: [
    {
      id: 'profile-1',
      name: 'First profile',
      api_key_set: true,
      realtime_api_key_set: true,
      asr_provider: 'openai_compat',
      asr_base_url: 'https://file.example/v1',
      asr_model: 'file-model',
      realtime_asr_provider: 'realtime_http',
      realtime_asr_base_url: 'https://realtime.example',
      realtime_asr_model: 'realtime-model',
    },
    {
      id: 'profile-2',
      name: 'Second profile',
      api_key_set: false,
      realtime_api_key_set: secondProfile,
      asr_provider: 'openai_compat',
      asr_base_url: '',
      asr_model: '',
      realtime_asr_provider: 'realtime_http',
      realtime_asr_base_url: '',
      realtime_asr_model: '',
    },
  ],
  file: 'profile-1',
  realtime: 'profile-1',
});

function renderConfig(secondProfile = false) {
  const profiles = profilesFixture(secondProfile);
  const profileBodies: Record<string, unknown>[] = [];
  const authedFetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/asr/config') return jsonResponse({ available_providers: ['openai_compat'] });
    if (url === '/asr/realtime/sessions') {
      return jsonResponse({ providers: ['realtime_http', 'realtime_mock'] });
    }
    if (url === '/asr/profiles') return jsonResponse(profiles);
    if (url === '/asr/profiles/profile-1' && options?.method === 'PUT') {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      profileBodies.push(body);
      return jsonResponse({ profile: { id: 'profile-1' } });
    }
    throw new Error(`Unexpected request: ${options?.method ?? 'GET'} ${url}`);
  });

  render(<ConfigView authedFetch={authedFetch} refreshTopbar={vi.fn(async () => {})} />);
  return { authedFetch, profileBodies };
}

describe('<ConfigView /> profile API keys', () => {
  it('offers a retry instead of leaving the configuration page loading forever', async () => {
    const user = userEvent.setup();
    const failed = { ok: false, status: 503, text: async () => 'temporarily unavailable' } as Response;
    const profiles = profilesFixture();
    let configCalls = 0;
    const authedFetch = vi.fn(async (url: string) => {
      if (url === '/asr/config') {
        configCalls += 1;
        return configCalls === 1 ? failed : jsonResponse({ available_providers: ['openai_compat'] });
      }
      if (url === '/asr/realtime/sessions') return jsonResponse({ providers: ['realtime_http', 'realtime_mock'] });
      if (url === '/asr/profiles') return jsonResponse(profiles);
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ConfigView authedFetch={authedFetch} refreshTopbar={vi.fn(async () => {})} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('读取服务配置失败');
    await user.click(screen.getByRole('button', { name: '重试加载' }));
    expect(await screen.findByRole('button', { name: '保存这份配置' })).toBeInTheDocument();
    expect(authedFetch).toHaveBeenCalledTimes(5);
  });

  it('keeps the profile\'s saved values when /asr/config arrives after the profile list', async () => {
    const user = userEvent.setup();
    // Mount fires loadConfig() and loadProfiles() together, but they are not
    // equally fast: /asr/realtime/sessions waits on a live ASR probe, so in the
    // browser the profile fills the form first and config lands on top of it.
    // /asr/config only knows the global keys under different names (provider,
    // base_url, …), so filling it *over* the form blanked every saved address,
    // model and provider — the user saw empty inputs, and the next save wrote
    // those blanks back into the profile. The gate below is that arrival order.
    const profileBodies: Record<string, unknown>[] = [];
    // Deferred until the macrotask after the profile list has been applied, so
    // config demonstrably lands on top of a form the profile already filled.
    let releaseConfig: () => void = () => {};
    const configArrivesLast = new Promise<void>((resolve) => { releaseConfig = resolve; });
    const authedFetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/asr/config') {
        await configArrivesLast;
        return jsonResponse({
          available_providers: ['openai_compat', 'openai_chat_audio'],
          provider: 'openai_chat_audio',
          base_url: '',
          model: '',
          language: 'zh',
          timestamps: false,
          hotwords: '',
          prompt_hints: '',
          concurrency: 4,
          max_retries: 2,
          retry_backoff: 1.5,
          timeout: 120,
          split_strategy: 'silence',
          chunk_seconds: 300,
          overlap_seconds: 3,
          silence_noise_db: -30,
          silence_min_duration: 0.6,
          max_upload_bytes: 2048 * 1024 * 1024,
          realtime_asr_provider: 'realtime_mock',
          realtime_asr_base_url: '',
          realtime_asr_model: '',
          realtime_max_chunk_bytes: 1024 * 1024,
          realtime_session_ttl_seconds: 300,
          access_tokens_count: 0,
        });
      }
      if (url === '/asr/realtime/sessions') {
        return jsonResponse({ providers: ['realtime_http', 'realtime_mock'] });
      }
      if (url === '/asr/profiles') {
        // A real macrotask gap, so React has committed the profile and applied
        // it to the form before /asr/config is allowed to answer.
        setTimeout(releaseConfig, 50);
        return jsonResponse(profilesFixture());
      }
      if (url === '/asr/profiles/profile-1' && options?.method === 'PUT') {
        profileBodies.push(JSON.parse(String(options.body)) as Record<string, unknown>);
        return jsonResponse({ profile: { id: 'profile-1' } });
      }
      throw new Error(`Unexpected request: ${options?.method ?? 'GET'} ${url}`);
    });

    render(<ConfigView authedFetch={authedFetch} refreshTopbar={vi.fn(async () => {})} />);

    await screen.findByRole('button', { name: '保存这份配置' });
    expect(await screen.findByDisplayValue('https://file.example/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('file-model')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://realtime.example')).toBeInTheDocument();
    expect(screen.getByDisplayValue('realtime-model')).toBeInTheDocument();
    expect(screen.getByLabelText('接口类型')).toHaveValue('openai_compat');
    expect(screen.getByLabelText('实时接口类型')).toHaveValue('realtime_http');
    // Global fields still come from /asr/config — the other half of the merge.
    // They live behind the collapsed 音频切分 group, so open it first.
    await user.click(screen.getByRole('button', { name: /音频切分/ }));
    expect(await screen.findByLabelText('每片时长（秒）')).toHaveValue(300);
    expect(screen.getByLabelText('单次上传上限（GB）')).toHaveValue(2);

    // Saving an untouched profile must not be a way to erase it.
    await user.clear(screen.getByLabelText('配置名称'));
    await user.type(screen.getByLabelText('配置名称'), 'Renamed');
    await user.click(screen.getByRole('button', { name: '保存这份配置' }));
    await waitFor(() => expect(profileBodies).toHaveLength(1));
    expect(profileBodies[0]).toMatchObject({
      asr_provider: 'openai_compat',
      asr_base_url: 'https://file.example/v1',
      asr_model: 'file-model',
      realtime_asr_provider: 'realtime_http',
      realtime_asr_base_url: 'https://realtime.example',
      realtime_asr_model: 'realtime-model',
    });
  });

  it('associates configuration field captions with their controls', async () => {
    renderConfig();

    await screen.findByRole('button', { name: '保存这份配置' });
    expect(screen.getByLabelText('接口类型')).toBeInTheDocument();
    expect(screen.getByLabelText('接口地址')).toBeInTheDocument();
    expect(screen.getByLabelText('API 密钥')).toBeInTheDocument();
    expect(screen.getByLabelText('模型名称')).toBeInTheDocument();
  });
  it('omits untouched empty API key fields from the profile save body', async () => {
    const user = userEvent.setup();
    const { profileBodies } = renderConfig();

    await screen.findByRole('button', { name: '保存这份配置' });
    await user.clear(screen.getByLabelText('配置名称'));
    await user.type(screen.getByLabelText('配置名称'), 'Renamed profile');
    await user.click(screen.getByRole('button', { name: '保存这份配置' }));

    await waitFor(() => expect(profileBodies).toHaveLength(1));
    expect(profileBodies[0]).not.toHaveProperty('asr_api_key');
    expect(profileBodies[0]).not.toHaveProperty('realtime_asr_api_key');
  });

  it('sends empty strings for explicitly cleared keys and resets the draft after save', async () => {
    const user = userEvent.setup();
    const { profileBodies } = renderConfig();

    await user.click(await screen.findByRole('button', { name: '清除API 密钥' }));
    await user.click(screen.getByRole('button', { name: '清除实时接口密钥' }));
    expect(screen.getAllByPlaceholderText('保存时将清除此配置中的密钥')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '保存这份配置' }));

    await waitFor(() => expect(profileBodies).toHaveLength(1));
    expect(profileBodies[0]).toHaveProperty('asr_api_key', '');
    expect(profileBodies[0]).toHaveProperty('realtime_asr_api_key', '');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '清除API 密钥' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '清除实时接口密钥' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '取消清除API 密钥' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '取消清除实时接口密钥' })).not.toBeInTheDocument();
      expect(screen.getAllByPlaceholderText('输入新值以覆盖，留空表示不修改')).toHaveLength(3);
    });
  });

  it('only offers clearing configured keys and discards drafts when switching profiles', async () => {
    const user = userEvent.setup();
    renderConfig(true);

    await user.click(await screen.findByRole('button', { name: '清除API 密钥' }));
    expect(screen.getByRole('button', { name: '清除实时接口密钥' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Second profile' }));
    expect(screen.queryByRole('button', { name: '清除API 密钥' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清除实时接口密钥' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'First profile' }));
    expect(await screen.findByRole('button', { name: '清除API 密钥' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消清除API 密钥' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新增配置' }));
    expect(screen.queryByRole('button', { name: '清除API 密钥' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '清除实时接口密钥' })).not.toBeInTheDocument();
  });
});
