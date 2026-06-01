import React, { useState, useEffect } from 'react';
import { Save, RotateCcw, Activity, Eye, EyeOff, Server, Scissors, Radio, ShieldCheck } from 'lucide-react';
import { SystemConfig } from '../types';

interface ConfigViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  refreshTopbar: () => Promise<void>;
}

// [apiKey, 中文标签, 类型, 提示]
type FieldType = 'select' | 'select-split' | 'select-realtime' | 'text' | 'secret' | 'bool' | 'int' | 'float';
interface FieldDef { key: string; label: string; type: FieldType; hint?: string; }
interface FieldGroup { title: string; icon: any; desc: string; fields: FieldDef[]; }

const GROUPS: FieldGroup[] = [
  {
    title: '语音识别接口', icon: Server, desc: '文件转写要用到的 ASR 服务，必须先填好这里才能开始转写',
    fields: [
      { key: 'asr_provider', label: '接口类型', type: 'select', hint: 'openai_compat = Whisper 风格；openai_chat_audio = vLLM Qwen3-ASR 等多模态对话接口' },
      { key: 'asr_base_url', label: '接口地址', type: 'text', hint: '形如 https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { key: 'asr_api_key', label: 'API 密钥', type: 'secret', hint: '调用上游所需的 Key；内网无鉴权可留空' },
      { key: 'asr_model', label: '模型名称', type: 'text', hint: '例如 qwen3-asr-flash' },
      { key: 'asr_language', label: '识别语言', type: 'text', hint: 'zh 中文 / en 英文 / 留空自动判断' },
      { key: 'asr_hotwords', label: '热词', type: 'text', hint: '逗号分隔的专有名词，提高识别准确率（可选）' },
      { key: 'asr_prompt_hints', label: '上下文提示', type: 'text', hint: '自由文本，告诉模型这段音频的背景（可选）' },
      { key: 'asr_timestamps', label: '请求逐字时间戳', type: 'bool', hint: '开启后字幕更精准；上游不支持时请关闭' },
      { key: 'asr_timeout', label: '单次超时（秒）', type: 'float' },
      { key: 'asr_concurrency', label: '并发分片数', type: 'int', hint: '同时识别的分片数量，越大越快但更耗资源' },
      { key: 'asr_max_retries', label: '失败重试次数', type: 'int' },
      { key: 'asr_retry_backoff', label: '重试退避系数', type: 'float' },
    ],
  },
  {
    title: '音频切分', icon: Scissors, desc: '长音频会先切成小片再并发识别',
    fields: [
      { key: 'split_strategy', label: '切分策略', type: 'select-split', hint: 'silence 按静音切（推荐）/ fixed 固定时长 / overlap 重叠切' },
      { key: 'split_chunk_seconds', label: '每片时长（秒）', type: 'float' },
      { key: 'split_overlap_seconds', label: '重叠时长（秒）', type: 'float', hint: '仅 overlap 策略生效' },
      { key: 'silence_noise_db', label: '静音判定阈值（dB）', type: 'float', hint: '越小越严格，常用 -30' },
      { key: 'silence_min_duration', label: '最短静音时长（秒）', type: 'float' },
      { key: 'max_upload_bytes', label: '单次上传上限（字节）', type: 'int' },
    ],
  },
  {
    title: '实时识别', icon: Radio, desc: '「实时识别」页面使用的下游服务',
    fields: [
      { key: 'realtime_asr_provider', label: '实时接口类型', type: 'select-realtime', hint: 'realtime_mock = 演示用假数据；realtime_http = 对接标准实时服务' },
      { key: 'realtime_asr_base_url', label: '实时接口地址', type: 'text' },
      { key: 'realtime_asr_api_key', label: '实时接口密钥', type: 'secret' },
      { key: 'realtime_asr_model', label: '实时模型名称', type: 'text' },
      { key: 'realtime_max_chunk_bytes', label: '单包最大字节', type: 'int' },
      { key: 'realtime_session_ttl_seconds', label: '会话超时（秒）', type: 'int' },
    ],
  },
  {
    title: '访问控制', icon: ShieldCheck, desc: '给整个服务加一道令牌校验（可选）',
    fields: [
      { key: 'access_tokens', label: '访问令牌', type: 'secret', hint: '逗号分隔多个令牌，留空 = 不启用鉴权' },
    ],
  },
];

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

const ALL_FIELDS = GROUPS.flatMap(g => g.fields);

export const ConfigView: React.FC<ConfigViewProps> = ({ authedFetch, refreshTopbar }) => {
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [realtimeProviders, setRealtimeProviders] = useState<string[]>(['realtime_mock', 'realtime_http']);
  const [formState, setFormState] = useState<{ [key: string]: any }>({});
  const [dirtyFields, setDirtyFields] = useState<{ [key: string]: boolean }>({});
  const [showSecrets, setShowSecrets] = useState<{ [key: string]: boolean }>({});

  const [pingStatus, setPingStatus] = useState('未测试');
  const [pingClass, setPingClass] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const loadConfig = async () => {
    try {
      const r = await authedFetch('/asr/config');
      if (r.ok) {
        const cfg = await r.json();
        setConfig(cfg);
        const initialForm: { [key: string]: any } = {};
        for (const f of ALL_FIELDS) {
          const apiKey = CFG_KEY_TO_API[f.key];
          if (f.type === 'bool') initialForm[f.key] = !!cfg[apiKey];
          else if (f.type === 'secret') initialForm[f.key] = '';
          else initialForm[f.key] = cfg[apiKey] !== undefined ? cfg[apiKey] : (cfg[f.key] !== undefined ? cfg[f.key] : '');
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

  useEffect(() => { loadConfig(); }, []);

  const handleChange = (key: string, value: any) => {
    setFormState(prev => ({ ...prev, [key]: value }));
    setDirtyFields(prev => ({ ...prev, [key]: true }));
  };

  const collectDiff = () => {
    const out: { [key: string]: any } = {};
    for (const f of ALL_FIELDS) {
      if (!dirtyFields[f.key]) continue;
      const val = formState[f.key];
      if (f.type === 'secret') { if (val !== '') out[f.key] = val; }
      else if (f.type === 'bool') out[f.key] = !!val;
      else if (f.type === 'int') { const n = parseInt(val, 10); if (Number.isFinite(n)) out[f.key] = n; }
      else if (f.type === 'float') { const fl = parseFloat(val); if (Number.isFinite(fl)) out[f.key] = fl; }
      else out[f.key] = val;
    }
    return out;
  };

  const handleSave = async () => {
    const diff = collectDiff();
    if (Object.keys(diff).length === 0) {
      setSaveStatus('没有改动需要保存');
      setTimeout(() => setSaveStatus(null), 3000);
      return;
    }
    setSaveStatus('保存中…');
    try {
      const r = await authedFetch('/asr/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(diff),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `${r.status}`); }
      await loadConfig();
      await refreshTopbar();
      setSaveStatus(`✓ 已保存 ${Object.keys(diff).length} 项，立即生效`);
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (e: any) {
      setSaveStatus(`✗ 保存失败：${e.message}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const handleReset = async () => {
    if (!confirm('确认放弃所有在线修改，恢复为部署时 .env 的默认值？')) return;
    setSaveStatus('恢复中…');
    try {
      const r = await authedFetch('/asr/config/reset', { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadConfig();
      await refreshTopbar();
      setSaveStatus('✓ 已恢复为默认值');
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (e: any) {
      setSaveStatus(`✗ 恢复失败：${e.message}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const handlePing = async () => {
    setIsTesting(true);
    setPingStatus('正在测试连接…');
    setPingClass('warn');
    try {
      const r = await authedFetch('/asr/ping', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        setPingStatus(`✓ 连接正常 · ${d.elapsed_ms.toFixed(0)}ms · ${d.model}${d.got_words ? ' · 含时间戳' : ' · 无时间戳'}`);
        setPingClass('ok');
      } else {
        setPingStatus(`✗ 连接失败 · ${d.error || '未知错误'}`);
        setPingClass('err');
      }
    } catch (e: any) {
      setPingStatus(`✗ 网络错误：${e.message}`);
      setPingClass('err');
    } finally {
      setIsTesting(false);
    }
  };

  const secretBadge = (key: string) => {
    if (!config) return null;
    if (key === 'asr_api_key') return config.api_key_set ? '已配置' : '未配置';
    if (key === 'access_tokens') return (config.access_tokens_count || 0) > 0 ? `已配置 ${config.access_tokens_count} 个` : '未启用';
    if (key === 'realtime_asr_api_key') return '已隐藏';
    return null;
  };

  const renderField = (f: FieldDef) => {
    const isDirty = !!dirtyFields[f.key];
    const val = formState[f.key];
    return (
      <div key={f.key} className={`flex flex-col gap-1.5 p-3.5 rounded-xl border transition-colors ${isDirty ? 'border-accent/40 bg-accent-soft/50' : 'border-border bg-white'}`}>
        {f.type !== 'bool' && (
          <div className="flex justify-between items-center text-xs font-semibold text-fg-dim">
            <span>{f.label}{isDirty && <span className="text-accent ml-1">·已改</span>}</span>
            {f.type === 'secret' && <span className="badge text-[9px] scale-90">{secretBadge(f.key)}</span>}
          </div>
        )}

        {f.type === 'select' && (
          <select value={val} onChange={e => handleChange(f.key, e.target.value)}>
            {(config?.available_providers || []).map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        {f.type === 'select-split' && (
          <select value={val} onChange={e => handleChange(f.key, e.target.value)}>
            {['fixed', 'silence', 'overlap'].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        {f.type === 'select-realtime' && (
          <select value={val} onChange={e => handleChange(f.key, e.target.value)}>
            {realtimeProviders.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        {f.type === 'bool' && (
          <label className="flex items-center gap-2 cursor-pointer py-1 text-fg text-[13px] font-semibold select-none">
            <input type="checkbox" checked={!!val} onChange={e => handleChange(f.key, e.target.checked)}
              className="w-4 h-4 rounded border-border accent-accent" />
            <span>{f.label}{isDirty && <span className="text-accent ml-1 text-xs">·已改</span>}</span>
          </label>
        )}
        {f.type === 'secret' && (
          <div className="relative flex items-center">
            <input type={showSecrets[f.key] ? 'text' : 'password'} value={val}
              onChange={e => handleChange(f.key, e.target.value)}
              placeholder="输入新值以覆盖，留空表示不修改" className="pr-10" />
            <button onClick={() => setShowSecrets(prev => ({ ...prev, [f.key]: !prev[f.key] }))}
              className="absolute right-2 text-muted hover:text-fg p-1 border-none bg-transparent hover:bg-transparent">
              {showSecrets[f.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        )}
        {(f.type === 'int' || f.type === 'float') && (
          <input type="number" step={f.type === 'float' ? '0.1' : '1'} value={val}
            onChange={e => handleChange(f.key, e.target.value)} />
        )}
        {f.type === 'text' && (
          <input type="text" value={val} onChange={e => handleChange(f.key, e.target.value)} />
        )}

        {f.hint && <span className="text-[11px] text-muted font-normal leading-snug">{f.hint}</span>}
      </div>
    );
  };

  if (!config) {
    return <div className="text-muted font-mono text-xs text-center py-20 animate-pulse">正在读取服务配置…</div>;
  }

  return (
    <div className="flex flex-col gap-6 pb-24">
      {GROUPS.map((g) => {
        const Icon = g.icon;
        return (
          <div key={g.title} className="card p-6">
            <h3 className="section-title mb-1">
              <Icon className="w-5 h-5 text-accent" />
              <span>{g.title}</span>
            </h3>
            <p className="hint mb-5">{g.desc}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {g.fields.map(renderField)}
            </div>
          </div>
        );
      })}

      {/* Sticky action bar */}
      <div className="fixed bottom-0 left-0 md:left-[244px] right-0 bg-surface/95 backdrop-blur border-t border-border px-5 md:px-7 py-3.5 flex items-center gap-3 flex-wrap z-30">
        <button onClick={handleSave} className="primary">
          <Save className="w-4 h-4" /><span>保存配置</span>
        </button>
        <button onClick={handleReset} className="danger">
          <RotateCcw className="w-4 h-4" /><span>恢复默认</span>
        </button>
        <button onClick={handlePing} disabled={isTesting}>
          <Activity className="w-4 h-4" /><span>测试连接</span>
        </button>
        {pingStatus !== '未测试' && <span className={`toast ${pingClass}`}>{pingStatus}</span>}
        {saveStatus && <span className="toast ok ml-auto">{saveStatus}</span>}
      </div>
    </div>
  );
};
