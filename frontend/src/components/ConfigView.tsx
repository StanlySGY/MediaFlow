import React, { useState, useEffect } from 'react';
import { Save, RotateCcw, Activity, Eye, EyeOff, Server, Scissors, Radio, ShieldCheck, RefreshCw, ChevronDown } from 'lucide-react';
import { SystemConfig } from '../types';
import { errorMessage } from '../lib/errors';

interface ConfigViewProps {
  authedFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  refreshTopbar: () => Promise<void>;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai_compat: '标准语音接口（兼容 Whisper / OpenAI）',
  openai_chat_audio: '对话式语音接口（Qwen3-ASR 等）',
};
const SPLIT_LABELS: Record<string, string> = {
  silence: '按静音切分（推荐）',
  fixed: '固定时长切分',
  overlap: '重叠切分',
};
const REALTIME_LABELS: Record<string, string> = {
  realtime_ws: 'WebSocket 直连（边说边出字）',
  realtime_http: 'HTTP 流式（边说边出字）',
  realtime_offline: '录完再识别',
  realtime_mock: '演示数据（不调用真实服务）',
};

// Byte counts are stored as raw numbers but shown in GB or MB, whichever
// keeps the value readable.
const byteUnit = (n: number): [number, string] =>
  n >= 1024 ** 3 ? [1024 ** 3, 'GB'] : [1024 ** 2, 'MB'];
const formatBytes = (n: number) => {
  const [div] = byteUnit(n);
  return String(Math.round((n / div) * 100) / 100);
};

const labeledOptions = (ids: string[], labels: Record<string, string>) =>
  ids.map(id => <option key={id} value={id}>{labels[id] ?? id}</option>);
type FieldType = 'select' | 'select-split' | 'select-realtime' | 'text' | 'secret' | 'bool' | 'int' | 'float' | 'bytes';
interface FieldDef { key: string; label: string; type: FieldType; hint?: string; wide?: boolean; }
interface FieldGroup { title: string; icon: React.ComponentType<{ className?: string }>; desc: string; fields: FieldDef[]; advanced?: FieldDef[]; collapsed?: boolean; }

const GROUPS: FieldGroup[] = [
  {
    title: '语音识别接口', icon: Server, desc: '给「文件转写」用：上传一段已经录好的音频或视频，识别成文字',
    fields: [
      { key: 'asr_provider', label: '接口类型', type: 'select', hint: '不确定选哪个时，绝大多数兼容 OpenAI 的语音接口都用第一种', wide: true },
      { key: 'asr_base_url', label: '接口地址', type: 'text', hint: '形如 https://dashscope.aliyuncs.com/compatible-mode/v1', wide: true },
      { key: 'asr_api_key', label: 'API 密钥', type: 'secret', hint: '调用上游所需的 Key；内网无鉴权可留空', wide: true },
      { key: 'asr_model', label: '模型名称', type: 'text', hint: '点「获取模型」从接口地址自动读取，也可直接手填' },
      { key: 'asr_language', label: '识别语言', type: 'text', hint: 'zh 中文 / en 英文，也支持 30 种语言的短码（ja、ko、yue 等）；留空自动判断' },
      { key: 'asr_hotwords', label: '热词', type: 'text', hint: '逗号分隔的专有名词，提高识别准确率（可选）', wide: true },
    ],
    advanced: [
      { key: 'asr_prompt_hints', label: '上下文提示', type: 'text', hint: '自由文本，告诉模型这段音频的背景（可选）', wide: true },
      { key: 'asr_timestamps', label: '请求逐字时间戳', type: 'bool', hint: '开启后字幕更精准；上游不支持时请关闭', wide: true },
      { key: 'asr_timeout', label: '单次超时（秒）', type: 'float' },
      { key: 'asr_concurrency', label: '并发分片数', type: 'int', hint: '同时识别的分片数量，越大越快但更耗资源' },
      { key: 'asr_max_retries', label: '失败重试次数', type: 'int' },
      { key: 'asr_retry_backoff', label: '重试退避系数', type: 'float' },
    ],
  },
  {
    title: '音频切分', icon: Scissors, desc: '只影响「文件转写」：长录音会先切成小段再识别，出厂值通常不用改', collapsed: true,
    fields: [
      { key: 'split_strategy', label: '切分策略', type: 'select-split', hint: '按静音切最适合讲话录音；固定时长切分最稳妥' },
      { key: 'split_chunk_seconds', label: '每片时长（秒）', type: 'float' },
      { key: 'split_overlap_seconds', label: '重叠时长（秒）', type: 'float', hint: '仅 overlap 策略生效' },
      { key: 'silence_noise_db', label: '静音判定阈值（dB）', type: 'float', hint: '越小越严格，常用 -30' },
      { key: 'silence_min_duration', label: '最短静音时长（秒）', type: 'float' },
      { key: 'max_upload_bytes', label: '单次上传上限（GB）', type: 'bytes' },
    ],
  },
  {
    title: '实时识别', icon: Radio, desc: '给「实时识别」用：不上传文件，对着麦克风说话、边说边出字',
    fields: [
      { key: 'realtime_asr_provider', label: '实时接口类型', type: 'select-realtime', hint: '边说边出字选前两种；只想录完再识别选第三种' },
      { key: 'realtime_asr_base_url', label: '实时接口地址', type: 'text', hint: 'WebSocket 示例：ws://<服务器IP>:8022/v1/asr/stream；HTTP+SSE 示例：http://<服务器IP>:8023' },
      { key: 'realtime_asr_api_key', label: '实时接口密钥', type: 'secret' },
      { key: 'realtime_asr_model', label: '实时模型名称', type: 'text', hint: '点「获取模型」从实时接口地址自动读取，也可直接手填' },
    ],
    advanced: [
      { key: 'realtime_max_chunk_bytes', label: '单包上限（MB）', type: 'bytes' },
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

const ALL_FIELDS = GROUPS.flatMap(g => [...g.fields, ...(g.advanced ?? [])]);

export const ConfigView: React.FC<ConfigViewProps> = ({ authedFetch, refreshTopbar }) => {
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [realtimeProviders, setRealtimeProviders] = useState<string[]>(['realtime_mock', 'realtime_http', 'realtime_offline', 'realtime_ws']);
  const [formState, setFormState] = useState<Record<string, string | number | boolean>>({});
  const [dirtyFields, setDirtyFields] = useState<{ [key: string]: boolean }>({});
  const [showSecrets, setShowSecrets] = useState<{ [key: string]: boolean }>({});

  const [pingStatus, setPingStatus] = useState('未测试');
  const [pingClass, setPingClass] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [realtimeModelOptions, setRealtimeModelOptions] = useState<string[]>([]);
  const [fetchingModelsFor, setFetchingModelsFor] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<{ key: string; text: string } | null>(null);

  const loadConfig = async () => {
    try {
      const r = await authedFetch('/asr/config');
      if (r.ok) {
        const cfg = await r.json();
        setConfig(cfg);
        const initialForm: Record<string, string | number | boolean> = {};
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
    } catch {}
  };

  // Load once on mount; loadConfig is stable for this view's lifetime.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadConfig(); }, []);

  const handleChange = (key: string, value: string | number | boolean) => {
    setFormState(prev => ({ ...prev, [key]: value }));
    setDirtyFields(prev => ({ ...prev, [key]: true }));
  };

  // Ask the upstream at the typed address which models it serves, so the name
  // doesn't have to be typed from memory. Works before the form is saved.
  // WebSocket addresses are probed over HTTP: the model list lives on the same
  // host, and the realtime path differs from the file path only in protocol.
  const fetchModels = async (fieldKey: 'asr_model' | 'realtime_asr_model') => {
    const baseKey = fieldKey === 'asr_model' ? 'asr_base_url' : 'realtime_asr_base_url';
    const keyKey = fieldKey === 'asr_model' ? 'asr_api_key' : 'realtime_asr_api_key';
    const raw = String(formState[baseKey] || '').trim();
    const base = raw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const note = (text: string) => {
      setModelStatus({ key: fieldKey, text });
      setTimeout(() => setModelStatus(prev => (prev?.key === fieldKey ? null : prev)), 5000);
    };
    if (!base) {
      note('请先填写接口地址');
      return;
    }
    setFetchingModelsFor(fieldKey);
    setModelStatus(null);
    try {
      const params = new URLSearchParams({ base_url: base });
      const key = String(formState[keyKey] || '');
      if (key) params.set('api_key', key);
      const r = await authedFetch(`/asr/models?${params}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      const ids: string[] = Array.isArray(d.models) ? d.models : [];
      const setOptions = fieldKey === 'asr_model' ? setModelOptions : setRealtimeModelOptions;
      if (ids.length === 0) {
        setOptions([]);
        note('接口没有返回可用模型，请手填');
        return;
      }
      setOptions(ids);
      if (ids.length === 1) handleChange(fieldKey, ids[0]);
      note(`读取到 ${ids.length} 个模型`);
    } catch (e) {
      note(`读取失败：${errorMessage(e)}`);
    } finally {
      setFetchingModelsFor(null);
    }
  };

  // 一键填入 Qwen3-ASR 原生 WebSocket 流式服务配置。
  const applyStreamingPreset = () => {
    const host = (() => {
      try {
        return window.location.hostname || 'localhost';
      } catch {
        return 'localhost';
      }
    })();
    handleChange('realtime_asr_provider', 'realtime_ws');
    handleChange('realtime_asr_base_url', `ws://${host}:8022/v1/asr/stream`);
    setStreamStatus('已填入流式服务地址，记得点「保存配置」');
    setTimeout(() => setStreamStatus(null), 5000);
  };

  // 探测流式服务 /health，确认已部署且模型已加载。
  const checkStreamingHealth = async () => {
    const base = String(formState['realtime_asr_base_url'] || '').replace(/\/+$/, '');
    if (!base) {
      setStreamStatus('请先填写实时接口地址');
      setTimeout(() => setStreamStatus(null), 4000);
      return;
    }
    setStreamStatus('检测中…');
    try {
      const provider = String(formState['realtime_asr_provider'] || '');
      const healthUrl = (() => {
        if (provider !== 'realtime_ws') return `${base}/health`;
        const url = new URL(base);
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        url.pathname = '/readyz';
        url.search = '';
        return url.href;
      })();
      const r = await fetch(healthUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json().catch(() => ({}));
      // Two shapes in the wild: the HTTP+SSE shim's /health answers
      // {"model_loaded":true}; Qwen3-ASR's own /readyz answers
      // {"status":"ready","backend":"qwen_asr","device":"npu:0"} with no
      // model_loaded key. Accept either, else a healthy service reads as broken.
      const ready = data.model_loaded === true || data.status === 'ready';
      const detail = [data.backend, data.device].filter(Boolean).join(' · ');
      setStreamStatus(
        ready
          ? `✓ 流式服务在线，模型已加载${detail ? ` · ${detail}` : ''}`
          : '流式服务在线，但模型尚未加载完成',
      );
    } catch (e) {
      setStreamStatus(`✗ 无法连接流式服务：${errorMessage(e)}`);
    }
    setTimeout(() => setStreamStatus(null), 6000);
  };

  const collectDiff = () => {
    const out: Record<string, string | number | boolean> = {};
    for (const f of ALL_FIELDS) {
      if (!dirtyFields[f.key]) continue;
      const val = formState[f.key];
      if (f.type === 'secret') { if (val !== '') out[f.key] = val; }
      else if (f.type === 'bool') out[f.key] = !!val;
      else if (f.type === 'int') { const n = parseInt(String(val), 10); if (Number.isFinite(n)) out[f.key] = n; }
      else if (f.type === 'float') { const fl = parseFloat(String(val)); if (Number.isFinite(fl)) out[f.key] = fl; }
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
    } catch (e) {
      setSaveStatus(`✗ 保存失败：${errorMessage(e)}`);
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
    } catch (e) {
      setSaveStatus(`✗ 恢复失败：${errorMessage(e)}`);
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
    } catch (e) {
      setPingStatus(`✗ 网络错误：${errorMessage(e)}`);
      setPingClass('err');
    } finally {
      setIsTesting(false);
    }
  };

  const secretBadge = (key: string) => {
    if (!config) return null;
    if (key === 'asr_api_key') return config.api_key_set ? '已配置' : '未配置';
    if (key === 'access_tokens') return (config.access_tokens_count || 0) > 0 ? `已配置 ${config.access_tokens_count} 个` : '未启用';
    if (key === 'realtime_asr_api_key') return config.realtime_api_key_set ? '已配置' : '未配置';
    return null;
  };

  const renderField = (f: FieldDef) => {
    const isDirty = !!dirtyFields[f.key];
    const val = formState[f.key];
    const sval = (val ?? '') as string | number;
    const knownModels = f.key === 'asr_model' ? modelOptions
      : f.key === 'realtime_asr_model' ? realtimeModelOptions
      : [];
    const modelChoices = knownModels.length > 0
      ? Array.from(new Set([String(sval), ...knownModels].filter(Boolean)))
      : [];
    return (
      <div key={f.key} className={`flex flex-col gap-1.5 p-3.5 rounded-lg border transition-colors ${f.wide ? 'md:col-span-2 lg:col-span-3' : ''} ${isDirty ? 'border-accent/40 bg-accent-soft/50' : 'border-border bg-white'}`}>
        {f.type !== 'bool' && (
          <div className="flex justify-between items-center text-xs font-semibold text-fg-dim">
            <span>{f.label}{isDirty && <span className="text-accent ml-1">·已改</span>}</span>
            {f.type === 'secret' && <span className="badge text-[9px] scale-90">{secretBadge(f.key)}</span>}
          </div>
        )}

        {f.type === 'select' && (
          <select value={sval} onChange={e => handleChange(f.key, e.target.value)}>
            {(config?.available_providers || []).map(p => <option key={p} value={p}>{PROVIDER_LABELS[p] ?? p}</option>)}
          </select>
        )}
        {f.type === 'select-split' && (
          <select value={sval} onChange={e => handleChange(f.key, e.target.value)}>
            {labeledOptions(['fixed', 'silence', 'overlap'], SPLIT_LABELS)}
          </select>
        )}
        {f.type === 'select-realtime' && (
          <select value={sval} onChange={e => handleChange(f.key, e.target.value)}>
            {labeledOptions(realtimeProviders, REALTIME_LABELS)}
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
            <input type={showSecrets[f.key] ? 'text' : 'password'} value={sval}
              onChange={e => handleChange(f.key, e.target.value)}
              placeholder="输入新值以覆盖，留空表示不修改" className="pr-10" />
            <button onClick={() => setShowSecrets(prev => ({ ...prev, [f.key]: !prev[f.key] }))}
              aria-label={showSecrets[f.key] ? '隐藏密钥' : '显示密钥'}
              className="absolute right-2 text-muted hover:text-fg p-1 border-none bg-transparent hover:bg-transparent">
              {showSecrets[f.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        )}
        {(f.type === 'int' || f.type === 'float') && (
          <input type="number" step={f.type === 'float' ? 'any' : '1'} value={sval}
            onChange={e => handleChange(f.key, e.target.value)} />
        )}
        {f.type === 'bytes' && (
          <div className="flex items-center gap-2">
            <input type="number" step="0.1" min="0"
              value={formatBytes(Number(sval) || 0)}
              onChange={e => {
                const [div] = byteUnit(Number(sval) || 0);
                handleChange(f.key, Math.round((Number(e.target.value) || 0) * div));
              }} />
            <span className="text-[12px] text-muted shrink-0">{byteUnit(Number(sval) || 0)[1]}</span>
          </div>
        )}
        {f.type === 'text' && modelChoices.length > 0 && (
          <select value={sval} onChange={e => handleChange(f.key, e.target.value)}>
            {modelChoices.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {f.type === 'text' && modelChoices.length === 0 && (
          <div className="flex items-center gap-2">
            <input type="text" value={sval} onChange={e => handleChange(f.key, e.target.value)} />
            {(f.key === 'asr_model' || f.key === 'realtime_asr_model') && (
              <button type="button" onClick={() => fetchModels(f.key as 'asr_model' | 'realtime_asr_model')}
                disabled={fetchingModelsFor !== null} className="shrink-0">
                <RefreshCw className={`w-4 h-4 ${fetchingModelsFor === f.key ? 'animate-spin' : ''}`} /><span>获取模型</span>
              </button>
            )}
          </div>
        )}

        {f.hint && <span className="text-[11px] text-muted font-normal leading-snug">{f.hint}</span>}
        {(f.key === 'asr_model' || f.key === 'realtime_asr_model') && modelStatus?.key === f.key && (
          <span className="text-[11px] text-fg-dim font-normal">{modelStatus.text}</span>
        )}
      </div>
    );
  };

  if (!config) {
    return <div className="text-muted text-sm text-center py-20">正在读取服务配置…</div>;
  }

  return (
    <div className="flex flex-col gap-6 pb-24">
      {GROUPS.map((g) => {
        const Icon = g.icon;
        return (
          <GroupCard key={g.title} group={g} icon={Icon} renderField={renderField}
            extra={g.title === '实时识别' ? (
              <div className="mt-4 p-3.5 rounded-lg border border-border bg-surface-2 flex flex-col gap-2">
                <div className="text-xs font-semibold text-fg-dim">Qwen3-ASR 真流式（边说边出字）</div>
                <p className="text-[11px] text-muted font-normal leading-snug">
                  选「WebSocket 直连」对接 Qwen3-ASR 的流式接口，或选「HTTP 流式」对接标准
                  流式服务；两种都会在录音期间持续返回文字。
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button type="button" onClick={applyStreamingPreset}>一键填入流式服务配置</button>
                  <button type="button" onClick={checkStreamingHealth} disabled={streamStatus === '检测中…'}>
                    <Activity className="w-4 h-4" /><span>检测流式服务状态</span>
                  </button>
                  {streamStatus && <span className="toast">{streamStatus}</span>}
                </div>
              </div>
            ) : undefined}
          />
        );
      })}

      {/* Sticky action bar */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 md:left-[calc(220px+(100%-220px)/2)] bg-surface border border-border shadow-lg rounded-lg px-3 py-2.5 flex items-center gap-2.5 z-30">
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
        {saveStatus && <span className="toast ok">{saveStatus}</span>}
      </div>
    </div>
  );
};

const GroupCard: React.FC<{
  group: FieldGroup;
  icon: React.ComponentType<{ className?: string }>;
  renderField: (f: FieldDef) => React.ReactNode;
  extra?: React.ReactNode;
}> = ({ group, icon: Icon, renderField, extra }) => {
  const [open, setOpen] = useState(!group.collapsed);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const grid = (fields: FieldDef[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {fields.map(renderField)}
    </div>
  );
  return (
    <div className="card p-6">
      <button type="button" onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left bg-transparent border-none p-0 hover:bg-transparent">
        <Icon className="w-5 h-5 text-accent" />
        <h3 className="section-title flex-1">{group.title}</h3>
        <ChevronDown className={`w-4 h-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-4">
          <p className="hint mb-5">{group.desc}</p>
          {grid(group.fields)}
          {extra}
          {group.advanced && (
            <div className="mt-4">
              <button type="button" onClick={() => setAdvancedOpen(v => !v)}
                aria-expanded={advancedOpen}
                className="text-[12px] text-muted bg-transparent border-none p-0 hover:bg-transparent hover:text-fg">
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                <span>{advancedOpen ? '收起高级参数' : `高级参数（${group.advanced.length} 项，一般不用改）`}</span>
              </button>
              {advancedOpen && <div className="mt-3">{grid(group.advanced)}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
