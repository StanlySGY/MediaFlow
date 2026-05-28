import React, { useState, useEffect } from 'react';
import { Settings2, Save, RotateCcw, Activity, HelpCircle, Eye, EyeOff } from 'lucide-react';
import { SystemConfig } from '../types';

interface ConfigViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  refreshTopbar: () => Promise<void>;
}

const CONFIG_FIELDS = [
  ['asr_provider',          'Provider',           'select'],
  ['asr_model',             'Model',              'text'],
  ['asr_base_url',          'Base URL',           'text'],
  ['asr_api_key',           'API Key',            'secret'],
  ['asr_language',          'Language',           'text'],
  ['asr_timestamps',        'Word timestamps',    'bool'],
  ['asr_hotwords',          'Hotwords',           'text'],
  ['asr_prompt_hints',      'Prompt hints',       'text'],
  ['asr_concurrency',       'Concurrency',        'int'],
  ['asr_max_retries',       'Max retries',        'int'],
  ['asr_retry_backoff',     'Retry backoff',      'float'],
  ['asr_timeout',           'ASR timeout (s)',    'float'],
  ['split_strategy',        'Split strategy',     'select-split'],
  ['split_chunk_seconds',   'Chunk seconds',      'float'],
  ['split_overlap_seconds', 'Overlap seconds',    'float'],
  ['silence_noise_db',      'Silence noise dB',   'float'],
  ['silence_min_duration',  'Silence min dur',    'float'],
  ['max_upload_bytes',      'Max upload bytes',   'int'],
  ['realtime_asr_provider', 'Realtime Provider',  'select-realtime'],
  ['realtime_asr_base_url', 'Realtime Base URL',  'text'],
  ['realtime_asr_api_key',  'Realtime API Key',   'secret'],
  ['realtime_asr_model',    'Realtime Model',     'text'],
  ['realtime_max_chunk_bytes', 'Realtime chunk max bytes', 'int'],
  ['realtime_session_ttl_seconds', 'Realtime session TTL', 'int'],
  ['access_tokens',         'Access tokens',      'secret'],
] as const;

const CFG_KEY_TO_API: { [key: string]: string } = {
  asr_provider: 'provider', asr_model: 'model', asr_base_url: 'base_url',
  asr_language: 'language', asr_timestamps: 'timestamps',
  asr_hotwords: 'hotwords', asr_prompt_hints: 'prompt_hints',
  asr_concurrency: 'concurrency', asr_max_retries: 'max_retries',
  asr_retry_backoff: 'retry_backoff', asr_timeout: 'timeout',
  split_strategy: 'split_strategy', split_chunk_seconds: 'chunk_seconds',
  split_overlap_seconds: 'overlap_seconds', silence_noise_db: 'silence_noise_db',
  silence_min_duration: 'silence_min_duration', max_upload_bytes: 'max_upload_bytes',
};

export const ConfigView: React.FC<ConfigViewProps> = ({
  authedFetch,
  refreshTopbar,
}) => {
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [realtimeProviders, setRealtimeProviders] = useState<string[]>(['realtime_mock', 'realtime_http']);
  const [formState, setFormState] = useState<{ [key: string]: any }>({});
  const [dirtyFields, setDirtyFields] = useState<{ [key: string]: boolean }>({});
  const [showSecrets, setShowSecrets] = useState<{ [key: string]: boolean }>({});

  const [pingStatus, setPingStatus] = useState('未测试');
  const [pingClass, setPingClass] = useState('text-gray-500 bg-white/2 border-white/5');
  const [isTesting, setIsTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const loadConfig = async () => {
    try {
      const r = await authedFetch('/asr/config');
      if (r.ok) {
        const cfg = await r.json();
        setConfig(cfg);
        
        // Load default form state from response
        const initialForm: { [key: string]: any } = {};
        for (const [key, , type] of CONFIG_FIELDS) {
          const apiKey = CFG_KEY_TO_API[key];
          if (type === 'bool') {
            initialForm[key] = !!cfg[apiKey];
          } else if (type === 'secret') {
            initialForm[key] = ''; // Keep secret empty for editing
          } else {
            initialForm[key] = cfg[apiKey] !== undefined ? cfg[apiKey] : (cfg[key] !== undefined ? cfg[key] : '');
          }
        }
        setFormState(initialForm);
        setDirtyFields({});
      }
      
      const rtRes = await authedFetch('/asr/realtime/sessions');
      if (rtRes.ok) {
        const rt = await rtRes.json();
        if (rt.providers) setRealtimeProviders(rt.providers);
      }
    } catch (e) {}
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleChange = (key: string, value: any) => {
    setFormState(prev => ({ ...prev, [key]: value }));
    setDirtyFields(prev => ({ ...prev, [key]: true }));
  };

  const collectDiff = () => {
    const out: { [key: string]: any } = {};
    for (const [key, , type] of CONFIG_FIELDS) {
      if (!dirtyFields[key]) continue;
      
      const val = formState[key];
      if (type === 'secret') {
        if (val !== '') out[key] = val;
      } else if (type === 'bool') {
        out[key] = !!val;
      } else if (type === 'int') {
        const n = parseInt(val, 10);
        if (Number.isFinite(n)) out[key] = n;
      } else if (type === 'float') {
        const f = parseFloat(val);
        if (Number.isFinite(f)) out[key] = f;
      } else {
        out[key] = val;
      }
    }
    return out;
  };

  const handleSave = async () => {
    const diff = collectDiff();
    if (Object.keys(diff).length === 0) {
      setSaveStatus('无任何改动');
      setTimeout(() => setSaveStatus(null), 3000);
      return;
    }

    setSaveStatus('保存中…');
    try {
      const r = await authedFetch('/asr/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diff),
      });

      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || `${r.status}`);
      }

      await loadConfig();
      await refreshTopbar();
      setSaveStatus(`✓ 已保存 ${Object.keys(diff).length} 项配置`);
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (e: any) {
      setSaveStatus(`✗ 保存失败: ${e.message}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const handleReset = async () => {
    if (!confirm('确认丢弃所有运行时自定义修改，恢复为 .env 环境变量默认值？')) return;
    
    setSaveStatus('恢复默认中…');
    try {
      const r = await authedFetch('/asr/config/reset', { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      
      await loadConfig();
      await refreshTopbar();
      setSaveStatus('✓ 已重置为 .env 默认');
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (e: any) {
      setSaveStatus(`✗ 重置失败: ${e.message}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const handlePing = async () => {
    setIsTesting(true);
    setPingStatus('连接探查中…');
    setPingClass('text-yellow-400 bg-yellow-400/5 border-yellow-400/10');
    
    try {
      const r = await authedFetch('/asr/ping', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        setPingStatus(`✓ ${d.elapsed_ms.toFixed(0)}ms · ${d.model}${d.got_words ? ' · words ✓' : ' · 无时间戳'}`);
        setPingClass('text-[#10b981] bg-[#10b981]/5 border-[#10b981]/10 drop-shadow-[0_0_10px_rgba(16,185,129,0.15)]');
      } else {
        setPingStatus(`✗ ${d.elapsed_ms.toFixed(0)}ms · ${d.error || 'unknown'}`);
        setPingClass('text-[#ef4444] bg-[#ef4444]/5 border-[#ef4444]/10');
      }
    } catch (e: any) {
      setPingStatus(`✗ 网络错误: ${e.message}`);
      setPingClass('text-[#ef4444] bg-[#ef4444]/5 border-[#ef4444]/10');
    } finally {
      setIsTesting(false);
    }
  };

  if (!config) {
    return (
      <div className="text-gray-500 font-mono text-xs text-center py-20 animate-pulse">
        正在拉取服务端配置项数据清单…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="border border-white/5 bg-white/2 rounded-2xl p-6 backdrop-blur-md">
        <h3 className="font-title text-base font-bold text-white flex items-center gap-2 mb-6">
          <Settings2 className="w-5 h-5 text-[#5c54f2]" />
          <span>服务运行时配置管理</span>
          <span className="text-xs text-gray-500 font-normal ml-1">实时覆盖修改 · 热重载生效 · 重启持久化</span>
        </h3>

        {/* Dynamic form grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {CONFIG_FIELDS.map(([key, label, type]) => {
            const isDirty = !!dirtyFields[key];
            const val = formState[key];
            
            return (
              <div
                key={key}
                className={`flex flex-col gap-2 p-4 rounded-xl border transition-colors ${
                  isDirty
                    ? 'border-[#5c54f2]/40 bg-[#5c54f2]/2'
                    : 'border-white/5 bg-white/1'
                }`}
              >
                {type !== 'bool' && (
                  <div className="flex justify-between items-center text-xs font-semibold text-gray-400">
                    <span className="flex items-center gap-1">
                      {label}
                      <span title={`配置文件KEY: ${key}`} className="cursor-help"><HelpCircle className="w-3.5 h-3.5 text-gray-600" /></span>
                    </span>

                    {/* Secret status badge indicators */}
                    {type === 'secret' && (
                      <span className="badge text-[9px] scale-90">
                        {key === 'asr_api_key' && (config.api_key_set ? '已配置密钥' : '未设置')}
                        {key === 'realtime_asr_api_key' && '加密掩码'}
                        {key === 'access_tokens' && ((config.access_tokens_count || 0) > 0 ? `${config.access_tokens_count} 个令牌` : '未设置')}
                      </span>
                    )}
                  </div>
                )}

                {/* Switch templates */}
                {type === 'select' && (
                  <select
                    value={val}
                    onChange={e => handleChange(key, e.target.value)}
                  >
                    {(config.available_providers || []).map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                )}

                {type === 'select-split' && (
                  <select
                    value={val}
                    onChange={e => handleChange(key, e.target.value)}
                  >
                    {['fixed', 'silence', 'overlap'].map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                )}

                {type === 'select-realtime' && (
                  <select
                    value={val}
                    onChange={e => handleChange(key, e.target.value)}
                  >
                    {realtimeProviders.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                )}

                {type === 'bool' && (
                  <label className="flex items-center gap-2 cursor-pointer py-1 text-gray-300 text-xs font-semibold select-none">
                    <input
                      type="checkbox"
                      checked={!!val}
                      onChange={e => handleChange(key, e.target.checked)}
                      className="w-4 h-4 rounded border-white/10 accent-[#5c54f2]"
                    />
                    <span>{label}</span>
                  </label>
                )}

                {type === 'secret' && (
                  <div className="relative flex items-center">
                    <input
                      type={showSecrets[key] ? 'text' : 'password'}
                      value={val}
                      onChange={e => handleChange(key, e.target.value)}
                      placeholder="输入新密钥以覆盖配置，留空表示不变"
                      className="pr-10"
                    />
                    <button
                      onClick={() => setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }))}
                      className="absolute right-2 text-gray-500 hover:text-gray-300 p-1 border-none bg-transparent hover:bg-transparent"
                    >
                      {showSecrets[key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                )}

                {(type === 'int' || type === 'float') && (
                  <input
                    type="number"
                    step={type === 'float' ? '0.1' : '1'}
                    value={val}
                    onChange={e => handleChange(key, e.target.value)}
                  />
                )}

                {type === 'text' && (
                  <input
                    type="text"
                    value={val}
                    onChange={e => handleChange(key, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Configurations Actions row */}
        <div className="flex items-center gap-3 mt-8 border-t border-white/5 pt-6 flex-wrap">
          <button onClick={handleSave} className="primary">
            <Save className="w-4 h-4" />
            <span>保存配置改动</span>
          </button>

          <button onClick={handleReset} className="danger">
            <RotateCcw className="w-4 h-4" />
            <span>重置为 .env 默认</span>
          </button>

          <button onClick={handlePing} disabled={isTesting}>
            <Activity className="w-4 h-4" />
            <span>探查上游 ASR 状态</span>
          </button>

          <span className={`toast ${pingClass}`}>
            {pingStatus}
          </span>
          
          {saveStatus && (
            <span className="toast text-[#10b981] bg-[#10b981]/5 border-[#10b981]/10 ml-auto">
              {saveStatus}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
