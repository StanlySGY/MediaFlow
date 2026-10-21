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
