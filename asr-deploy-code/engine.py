"""Qwen3-ASR 推理引擎（昇腾 NPU）。

兼容两种官方发布形态，启动时自动探测：
  1) transformers 原生 (Qwen/Qwen3-ASR-1.7B-hf, transformers >= 5.13)
     -> AutoProcessor + AutoModelForMultimodalLM / Qwen3ASRForConditionalGeneration
  2) qwen-asr 官方封装包 (Qwen/Qwen3-ASR-1.7B)
     -> qwen_asr.Qwen3ASRModel

流式策略：
- token 级增量：generate 挂 TextIteratorStreamer，边解码边推 delta；
- 段级增量：由上层 session 用 VAD 切句，段内出 partial、段末出 final。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import numpy as np

from .config import Settings

logger = logging.getLogger(__name__)

_SENTINEL = object()
_SPECIAL_TOKEN_RE = re.compile(r"<\|[^|>]*\|>")
_ASR_MARKER = "<asr_text>"
_LANG_PREFIX_RE = re.compile(r"^\s*language\s+([A-Za-z\u4e00-\u9fff\-_ ]+?)\s*$")


# --------------------------------------------------------------------------- #
# 输出解析
# --------------------------------------------------------------------------- #
class TranscriptionStreamParser:
    """把模型原始输出流 `language English<asr_text>正文...` 解析成增量正文。

    - 自动剥离语言标签头与 <asr_text> 标记
    - 自动过滤 <|...|> 类特殊 token
    - marker 被切分到两个 chunk 之间也能正确处理（基于全量 buffer 重算 delta）
    - 若模型未输出 header（超过 HEADER_PROBE_LIMIT 字符仍无 marker），退化为直出模式
    """

    HEADER_PROBE_LIMIT = 64

    def __init__(self) -> None:
        self.raw: str = ""
        self.language: Optional[str] = None
        self._emitted: int = 0
        self._header_resolved: bool = False
        self._body_offset: int = 0

    def feed(self, piece: str) -> str:
        if not piece:
            return ""
        self.raw += piece
        return self._recompute_delta()

    def finalize(self) -> str:
        """流结束时把剩余内容吐出来。"""
        if not self._header_resolved:
            self._resolve_header(force=True)
        return self._recompute_delta()

    # ------------------------------------------------------------------ #
    @property
    def text(self) -> str:
        if not self._header_resolved:
            return ""
        return self._clean(self.raw[self._body_offset:])

    def _recompute_delta(self) -> str:
        if not self._header_resolved:
            self._resolve_header(force=False)
            if not self._header_resolved:
                return ""
        full = self.text
        if len(full) <= self._emitted:
            # 清洗后可能变短（截断的特殊 token 被吃掉），等下一片
            return ""
        delta = full[self._emitted:]
        self._emitted = len(full)
        return delta

    def _resolve_header(self, force: bool) -> None:
        idx = self.raw.find(_ASR_MARKER)
        if idx >= 0:
            head = self._clean(self.raw[:idx])
            m = _LANG_PREFIX_RE.match(head)
            self.language = m.group(1).strip() if m else (head.strip() or None)
            self._body_offset = idx + len(_ASR_MARKER)
            self._header_resolved = True
            return
        if force or len(self.raw) > self.HEADER_PROBE_LIMIT:
            # 没有 marker：整段都是正文
            self._body_offset = 0
            self._header_resolved = True

    @staticmethod
    def _clean(s: str) -> str:
        return _SPECIAL_TOKEN_RE.sub("", s)


def parse_full_output(raw: str) -> Dict[str, Optional[str]]:
    p = TranscriptionStreamParser()
    p.feed(raw)
    p.finalize()
    return {"language": p.language, "text": p.text.strip()}


# --------------------------------------------------------------------------- #
# 结果对象
# --------------------------------------------------------------------------- #
@dataclass
class ASRResult:
    text: str
    language: Optional[str] = None
    duration_s: float = 0.0
    infer_ms: float = 0.0
    rtf: float = 0.0
    raw: str = ""


@dataclass
class EngineInfo:
    backend: str = "uninitialized"
    device: str = ""
    dtype: str = ""
    model_path: str = ""
    torch_version: str = ""
    torch_npu_version: str = ""
    transformers_version: str = ""
    npu_available: bool = False
    loaded: bool = False
    load_seconds: float = 0.0
    extra: Dict[str, Any] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# 后端探测 / 结果解析
# --------------------------------------------------------------------------- #
def _qwen_asr_available() -> bool:
    """探测 qwen-asr 官方包是否可导入（非 -hf 模型的推荐后端）。

    通过环境变量 ASR_DISABLE_QWEN_ASR=1/true/yes/on 可强制禁用，
    即使包已安装也会回退到 transformers 后端（用于灰度对比 / 排错）。
    """
    if os.environ.get("ASR_DISABLE_QWEN_ASR", "").strip().lower() in ("1", "true", "yes", "on"):
        return False
    try:
        import qwen_asr  # noqa: F401  # 导入即验证后端可用
        return True
    except ImportError:
        return False


def _parse_qwen_asr_result(res):
    """把 qwen-asr 的 transcribe 返回解析为 (text, language)。

    兼容多种返回形态：list[TranscriptionItem] / TranscriptionItem / dict。
    """
    item = res[0] if isinstance(res, (list, tuple)) else res
    if isinstance(item, dict):
        text = item.get("text", _SENTINEL)
        lang = item.get("language")
    else:
        text = getattr(item, "text", _SENTINEL)
        lang = getattr(item, "language", None)
    # 只有拿不到 text 字段才退化成 repr；空字符串是合法结果（静音/纯噪声），
    # 一旦当成缺失就会把 "ASRTranscription(text='', ...)" 当识别文本推给客户端。
    if text is _SENTINEL:
        text = str(item)
    return text or "", lang


# --------------------------------------------------------------------------- #
# 设备初始化
# --------------------------------------------------------------------------- #
def init_device(settings: Settings) -> Dict[str, Any]:
    """初始化计算设备；NPU 不可用时按配置回退 CPU。"""
    info: Dict[str, Any] = {"npu_available": False, "torch_npu_version": ""}
    import torch

    info["torch_version"] = torch.__version__

    if settings.device != "npu":
        info["resolved_device"] = settings.torch_device
        return info

    try:
        import torch_npu  # noqa: F401  # 导入即完成对 torch 的 monkey-patch
    except ImportError as exc:
        raise RuntimeError(
            "未安装 torch_npu，无法使用昇腾 NPU。请确认镜像内已安装与 CANN 匹配的 torch_npu，"
            "或将 ASR_DEVICE 设为 cpu。"
        ) from exc

    info["torch_npu_version"] = getattr(torch_npu, "__version__", "unknown")

    if not torch.npu.is_available():
        raise RuntimeError(
            "torch_npu 已安装但 npu 不可用。请检查：\n"
            "  1) 容器是否透传了 /dev/davinci* 与 /dev/davinci_manager /dev/devmm_svm /dev/hisi_hdc\n"
            "  2) 是否挂载了宿主机 /usr/local/Ascend/driver\n"
            "  3) LD_LIBRARY_PATH 是否包含驱动 lib64 路径\n"
            "  4) 在容器内执行 npu-smi info 是否正常"
        )

    try:
        torch_npu.npu.set_compile_mode(jit_compile=settings.npu_jit_compile)
    except Exception as exc:  # pragma: no cover
        logger.warning("set_compile_mode 失败（忽略）: %s", exc)
    try:
        torch_npu.npu.config.allow_internal_format = settings.npu_allow_internal_format
    except Exception as exc:  # pragma: no cover
        logger.warning("allow_internal_format 设置失败（忽略）: %s", exc)

    try:
        torch.npu.set_device(settings.torch_device)
    except RuntimeError as exc:
        err_msg = str(exc)
        if "50001" in err_msg or "SetPrecisionMode" in err_msg or "AclSetCompileopt" in err_msg:
            raise RuntimeError(
                "NPU 初始化失败（ACL error 50001: SetPrecisionMode）。\n"
                "  常见原因与解决方案（按优先级）：\n"
                "  1) CANN Toolkit 版本与宿主机 Driver 版本不匹配。\n"
                "     容器内 CANN 版本查看：cat /usr/local/Ascend/ascend-toolkit/latest/version.cfg\n"
                "     宿主机 Driver 版本查看：cat /usr/local/Ascend/driver/version.cfg (需挂载)\n"
                "     二者主版本号必须一致（如均为 8.2.x）。\n"
                "  2) 尝试切换精度模式（通过 docker-compose environment 覆盖）：\n"
                "     ASCEND_PRECISION_MODE=allow_fp32_to_fp16\n"
                "     可选值: force_fp16 / allow_fp32_to_fp16 / must_keep_origin_dtype\n"
                "  3) 增大算子工作内存：ASCEND_ATC_WORKSPACE_MEMORY_SIZE=4096\n"
                "  4) 确认设备节点已完整透传：\n"
                "     /dev/davinci0 /dev/davinci_manager /dev/devmm_svm /dev/hisi_hdc\n"
                f"  原始错误: {err_msg}"
            ) from exc
        raise
    info["npu_available"] = True
    info["npu_device_count"] = torch.npu.device_count()
    info["resolved_device"] = settings.torch_device
    logger.info(
        "昇腾 NPU 初始化完成: device=%s, count=%s, torch_npu=%s",
        settings.torch_device, info["npu_device_count"], info["torch_npu_version"],
    )
    return info


def resolve_dtype(name: str):
    import torch

    return {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }[name]


# --------------------------------------------------------------------------- #
# 引擎
# --------------------------------------------------------------------------- #
class ASREngine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.info = EngineInfo(model_path=settings.model_path, dtype=settings.dtype)
        self._model = None
        self._processor = None
        self._torch = None
        self._dtype = None
        self._device = settings.torch_device
        self._lock = threading.Lock()  # NPU 上串行化 generate，避免流并发踩踏
        self._sem: Optional[asyncio.Semaphore] = None
        self._partial_sem: Optional[asyncio.Semaphore] = None
        self._pool: Optional[ThreadPoolExecutor] = None

    # ------------------------------------------------------------- lifecycle
    def load(self) -> None:
        t0 = time.time()
        if not os.path.isdir(self.settings.model_path):
            raise RuntimeError(
                f"模型目录不存在: {self.settings.model_path}\n"
                f"请确认已通过 -v 把宿主机权重目录挂载进容器。"
            )

        dev_info = init_device(self.settings)
        self.info.npu_available = dev_info.get("npu_available", False)
        self.info.torch_version = dev_info.get("torch_version", "")
        self.info.torch_npu_version = dev_info.get("torch_npu_version", "")
        self._device = dev_info.get("resolved_device", self.settings.torch_device)
        self.info.device = self._device

        import torch

        self._torch = torch
        self._dtype = resolve_dtype(self.settings.dtype)

        backend = self.settings.backend
        errors: List[str] = []

        # auto 模式：若 qwen-asr 包已安装（非 -hf 模型最对路），优先用它；否则 transformers。
        prefer_qwen_asr = (backend == "qwen_asr") or (
            backend == "auto" and _qwen_asr_available()
        )
        order = ["qwen_asr", "transformers"] if prefer_qwen_asr else ["transformers", "qwen_asr"]

        for b in order:
            if backend not in ("auto", b):
                continue
            try:
                if b == "transformers":
                    self._load_transformers()
                    self.info.backend = "transformers"
                else:
                    self._load_qwen_asr()
                    self.info.backend = "qwen_asr"
                break
            except Exception as exc:
                errors.append(f"[{b}] {type(exc).__name__}: {exc}")
                logger.warning("%s 后端加载失败: %s", b, exc)
                if backend == b:  # 用户显式指定的后端失败 → 直接抛出
                    raise

        if self.info.backend == "uninitialized":
            raise RuntimeError("模型加载失败，所有后端均不可用：\n" + "\n".join(errors))

        self.info.loaded = True
        self.info.load_seconds = round(time.time() - t0, 2)
        logger.info(
            "模型加载完成: backend=%s device=%s dtype=%s 耗时=%.1fs",
            self.info.backend, self._device, self.settings.dtype, self.info.load_seconds,
        )

        if self.settings.warmup:
            try:
                self.warmup()
            except Exception as exc:  # pragma: no cover
                logger.warning("预热失败（不影响服务）: %s", exc)

    def _load_transformers(self) -> None:
        import transformers
        from transformers import AutoProcessor

        self.info.transformers_version = transformers.__version__
        logger.info("尝试 transformers 后端 (v%s)…", transformers.__version__)

        self._processor = AutoProcessor.from_pretrained(
            self.settings.model_path, trust_remote_code=True
        )

        model_cls = None
        for name in ("Qwen3ASRForConditionalGeneration", "AutoModelForMultimodalLM"):
            model_cls = getattr(transformers, name, None)
            if model_cls is not None:
                logger.info("使用模型类: %s", name)
                break
        if model_cls is None:
            raise RuntimeError(
                f"当前 transformers {transformers.__version__} 未提供 Qwen3-ASR 模型类，"
                "请升级到 >= 5.13.0，或改用 qwen-asr 后端。"
            )

        kwargs: Dict[str, Any] = {"trust_remote_code": True}
        if self.settings.attn_implementation:
            kwargs["attn_implementation"] = self.settings.attn_implementation

        model = None
        last: Optional[Exception] = None
        # 新版用 dtype=，旧版用 torch_dtype=
        for dtype_key in ("dtype", "torch_dtype"):
            try:
                model = model_cls.from_pretrained(
                    self.settings.model_path, **{dtype_key: self._dtype}, **kwargs
                )
                break
            except TypeError as exc:
                last = exc
            except Exception as exc:
                # attn_implementation 不被支持时降级重试
                if "attn_implementation" in kwargs:
                    logger.warning("attn_implementation=%s 不受支持，回退默认: %s",
                                   kwargs["attn_implementation"], exc)
                    kwargs.pop("attn_implementation")
                    last = exc
                    continue
                raise
        if model is None:
            raise RuntimeError(f"模型实例化失败: {last}")

        model = model.to(self._device).eval()
        self._model = model

    def _load_qwen_asr(self) -> None:
        from qwen_asr import Qwen3ASRModel

        logger.info("尝试 qwen-asr 后端…")
        # qwen-asr 不同版本 from_pretrained 形参不完全一致，按优先级尝试，遇 TypeError 逐步裁剪。
        base: Dict[str, Any] = {
            "dtype": self._dtype,
            "device_map": self._device,
            "max_new_tokens": self.settings.max_new_tokens,
        }
        last: Optional[Exception] = None
        for drop in (
            [],
            ["max_new_tokens"],
            ["max_new_tokens", "device_map"],
            ["max_new_tokens", "device_map", "dtype"],
        ):
            kwargs = {k: v for k, v in base.items() if k not in drop}
            try:
                self._model = Qwen3ASRModel.from_pretrained(self.settings.model_path, **kwargs)
                break
            except TypeError as exc:
                last = exc
        else:
            raise RuntimeError(f"qwen-asr 加载失败（参数不兼容）: {last}")

    def warmup(self) -> None:
        logger.info("开始预热（3s 合成语音）…")
        t0 = time.time()
        # 生成 3 秒 440Hz 正弦波（模拟真实语音，避免过短/静音导致 audio_features 边界问题）
        sr = self.settings.sample_rate
        duration = 3.0
        t = np.arange(int(sr * duration), dtype=np.float32) / sr
        dummy = np.sin(2 * np.pi * 440.0 * t) * 0.3  # 440Hz A 音，振幅 0.3
        # 叠加轻微包络避免首尾突变
        fade = int(sr * 0.05)
        dummy[:fade] *= np.linspace(0, 1, fade)
        dummy[-fade:] *= np.linspace(1, 0, fade)
        self.transcribe_sync(dummy, language=self.settings.language_or_none, max_new_tokens=8)
        logger.info("预热完成，耗时 %.1fs", time.time() - t0)

    def unload(self) -> None:
        self._model = None
        self._processor = None
        try:
            if self._torch is not None and self.info.npu_available:
                self._torch.npu.empty_cache()
        except Exception:
            pass

    # ------------------------------------------------------------ concurrency
    def bind_loop(self) -> None:
        """在事件循环启动后调用，创建并发闸门与推理线程池。

        推理是 GIL 受限的阻塞调用。如果丢给 run_in_executor(None, ...)，用的是
        事件循环默认的无界线程池（min(32, cpu+4) 个线程），信号量放行的请求会
        全部同时进入线程池抢 GIL 和显存，max_concurrency 就形同虚设——排队变成
        了颠簸。这里显式建一个 max_workers 与闸门对齐的池，超出的请求真正在
        队列里等，而不是挤进去互相拖慢。
        """
        limit = max(1, self.settings.max_concurrency)
        partial_limit = max(1, self.settings.partial_concurrency)
        self._sem = asyncio.Semaphore(limit)
        self._partial_sem = asyncio.Semaphore(partial_limit)
        # 两个信号量是独立闸门（整句走 _sem、partial 走 _partial_sem），最坏情况
        # 同时有 limit + partial_limit 个阻塞调用。池按这个上限开，闸门才是唯一
        # 的限流点；池开小了会变成第二道错位的闸门，反而把请求卡在池队列里。
        # streamer 的取词/join 是纯等待、不吃 GIL，仍留在默认线程池，避免占位。
        self._pool = ThreadPoolExecutor(
            max_workers=limit + partial_limit, thread_name_prefix="asr-infer"
        )
        logger.info("并发闸门就绪: max_concurrency=%d partial_concurrency=%d pool=%d",
                    limit, partial_limit, limit + partial_limit)

    def shutdown(self) -> None:
        """关停推理线程池（应用 lifespan 退出时调用）。"""
        pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)

    # -------------------------------------------------------------- inference
    def _build_inputs(self, audio: np.ndarray, language: Optional[str]):
        """构造 transformers 后端的模型输入（对齐官方 apply_transcription_request 用法）。

        关键点（来自 transformers 官方 Qwen3ASRProcessor 源码）：
          - audio 接受 numpy 数组（官方 _audio_content_item 对非字符串走 {"type":"audio","audio":x}）。
          - sampling_rate 不是 apply_transcription_request 的形参，必须放进 audio_kwargs，
            否则会被当多余 kwargs 丢弃并触发 transformers 的 WARNING，采样率回退默认 16000。
          - 返回的 BatchFeature 含：input_ids / attention_mask / input_features /
            input_features_mask / num_audio_tokens。audio 特征键名是 input_features（不是 audio_features）。
        """
        proc = self._processor
        sr = self.settings.sample_rate
        audio = np.ascontiguousarray(audio, dtype=np.float32)

        kwargs: Dict[str, Any] = {"audio_kwargs": {"sampling_rate": sr}}
        if language:
            kwargs["language"] = language

        try:
            inputs = proc.apply_transcription_request(audio=[audio], **kwargs)
        except Exception as exc:
            logger.warning("apply_transcription_request 直传数组失败(%s)，回退临时文件", exc)
            return self._build_inputs_via_tempfile(audio, language)

        self._log_processor_inputs(inputs)
        return inputs

    def _log_processor_inputs(self, inputs) -> None:
        """打印 processor 返回的关键张量信息，便于排查维度/设备不一致。"""
        for k in ("input_ids", "input_features", "input_features_mask", "num_audio_tokens"):
            v = inputs.get(k)
            if v is None:
                logger.warning("processor 返回缺少键: %s", k)
                continue
            if hasattr(v, "shape"):
                logger.debug(
                    "processor[%s] shape=%s dtype=%s device=%s",
                    k, tuple(v.shape), v.dtype, getattr(v, "device", "?"),
                )
            else:
                logger.debug("processor[%s] = %r", k, v)

    def _build_inputs_via_tempfile(self, audio: np.ndarray, language: Optional[str]):
        import soundfile as sf

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fp:
            path = fp.name
        try:
            sf.write(path, audio, self.settings.sample_rate, subtype="PCM_16")
            try:
                return self._processor.apply_transcription_request(
                    audio=[path],
                    language=language,
                    audio_kwargs={"sampling_rate": self.settings.sample_rate},
                )
            except Exception:
                content: List[Dict[str, Any]] = [{"type": "audio", "path": path}]
                convo: List[Dict[str, Any]] = []
                if language:
                    convo.append({"role": "system",
                                  "content": [{"type": "text", "text": language}]})
                convo.append({"role": "user", "content": content})
                return self._processor.apply_chat_template(
                    [convo], tokenize=True, return_dict=True,
                    audio_kwargs={"sampling_rate": self.settings.sample_rate},
                )
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    # 已知 Qwen3-ASR 处理器返回的真实音频张量键（来自官方 modeling/processing 源码）
    # 实际键名是 input_features（Whisper 风格音频编码器输出），不是 audio_features。
    _AUDIO_TENSOR_KEYS = (
        "input_features",
        "input_features_mask",
        "num_audio_tokens",
    )

    def _to_device(self, inputs):
        """把模型输入逐张量移到目标设备。

        不能用整体的 inputs.to(device, dtype)：
          - input_ids / attention_mask / input_features_mask / num_audio_tokens 是整型/布尔张量，
            整体 .to(bfloat16) 会把 Long 也转成浮点，导致嵌入层/掩码出错；
          - 只有浮点张量（input_features）需要转到计算 dtype（bfloat16/float16）。
        这里逐张量处理：先移设备，再仅对浮点张量应用 dtype。
        """
        import torch

        target = self._device
        ftype = self._dtype
        for key, val in list(inputs.items()):
            if not isinstance(val, torch.Tensor):
                continue
            moved = val.to(target)
            if val.is_floating_point():
                moved = moved.to(ftype)
            inputs[key] = moved
        return inputs

    def _transcribe_qwen_asr(self, audio: np.ndarray, language: Optional[str]):
        """调用 qwen-asr 后端转写。

        Qwen3ASRModel.transcribe(audio=...) 接受的音频类型（来自 qwen-asr 0.0.6 源码
        normalize_audio_input）：
          - str: 文件路径 / URL / base64 data url
          - (np.ndarray, int) 元组: (waveform, sample_rate)
          - list[上述]: 批量
        不接受裸 numpy 数组（会抛 Unsupported audio input type），也不接受
        sampling_rate / sample_rate 形参；内部用 librosa 自动重采样到 SAMPLE_RATE(16000)。
        """
        # 核心修复：把 ndarray 包装成 (array, sr) 元组（裸 ndarray 会被拒）
        audio_input = (audio, int(self.settings.sample_rate))
        kwargs: Dict[str, Any] = {"audio": audio_input}
        if language:
            kwargs["language"] = language
        return self._model.transcribe(**kwargs)

    def transcribe_sync(
        self,
        audio: np.ndarray,
        language: Optional[str] = None,
        max_new_tokens: Optional[int] = None,
    ) -> ASRResult:
        """阻塞式整段转写（线程内调用）。"""
        if self._model is None:
            raise RuntimeError("模型尚未加载")
        duration = float(audio.shape[0]) / self.settings.sample_rate
        mnt = max_new_tokens or self.settings.max_new_tokens
        t0 = time.time()

        with self._lock:
            if self.info.backend == "qwen_asr":
                res = self._transcribe_qwen_asr(audio, language)
                text, lang = _parse_qwen_asr_result(res)
                raw = text
            else:
                torch = self._torch
                inputs = self._to_device(self._build_inputs(audio, language))
                prompt_len = int(inputs["input_ids"].shape[1])

                # pre-generate 诊断：检查音频张量是否已正确迁移到目标设备
                for key in self._AUDIO_TENSOR_KEYS:
                    if key not in inputs:
                        continue
                    val = inputs[key]
                    if isinstance(val, (list, tuple)):
                        val = val[0] if val else None
                    if isinstance(val, torch.Tensor) and val.device.type != self._device.split(":")[0]:
                        logger.error(
                            "⚠️ 音频特征键 '%s' 未迁移到目标设备! 当前 device=%s, 期望=%s。"
                            "这会导致 'Audio features and audio tokens do not match' 错误。",
                            key, val.device, self._device,
                        )

                with torch.inference_mode():
                    out = self._model.generate(
                        **inputs, max_new_tokens=mnt, do_sample=False
                    )
                gen = out[:, prompt_len:]
                raw = self._decode_raw(gen)
                parsed = parse_full_output(raw)
                text, lang = parsed["text"], parsed["language"]

        infer_ms = (time.time() - t0) * 1000.0
        return ASRResult(
            text=(text or "").strip(),
            language=lang,
            duration_s=round(duration, 3),
            infer_ms=round(infer_ms, 1),
            rtf=round((infer_ms / 1000.0) / duration, 3) if duration > 0 else 0.0,
            raw=raw,
        )

    def _decode_raw(self, gen_ids) -> str:
        proc = self._processor
        for kwargs in ({"return_format": "raw"}, {}, {"skip_special_tokens": False}):
            try:
                out = proc.decode(gen_ids, **kwargs)
                if isinstance(out, (list, tuple)):
                    out = out[0]
                if isinstance(out, dict):
                    out = out.get("transcription") or out.get("text") or str(out)
                return str(out)
            except Exception:
                continue
        tok = getattr(proc, "tokenizer", None)
        if tok is not None:
            return tok.batch_decode(gen_ids, skip_special_tokens=False)[0]
        raise RuntimeError("无法解码模型输出")

    # ------------------------------------------------------------ async wrap
    async def transcribe(
        self,
        audio: np.ndarray,
        language: Optional[str] = None,
        max_new_tokens: Optional[int] = None,
        partial: bool = False,
    ) -> ASRResult:
        sem = self._partial_sem if partial and self._partial_sem else self._sem
        loop = asyncio.get_running_loop()
        run = lambda: self.transcribe_sync(audio, language, max_new_tokens)  # noqa: E731
        if sem is None:
            return await loop.run_in_executor(self._pool, run)
        async with sem:
            return await loop.run_in_executor(self._pool, run)

    async def transcribe_iter(
        self,
        audio: np.ndarray,
        language: Optional[str] = None,
        max_new_tokens: Optional[int] = None,
    ) -> AsyncIterator[Dict[str, Any]]:
        """token 级流式转写。

        yield {"type":"delta","text":...} / {"type":"final","text":...,"language":...}
        """
        if self._model is None:
            raise RuntimeError("模型尚未加载")

        # qwen_asr 后端不暴露 streamer，降级为一次性返回
        if self.info.backend == "qwen_asr" or not self.settings.stream_token_level:
            res = await self.transcribe(audio, language, max_new_tokens)
            if res.text:
                yield {"type": "delta", "text": res.text}
            yield {
                "type": "final", "text": res.text, "language": res.language,
                "infer_ms": res.infer_ms, "rtf": res.rtf, "duration_s": res.duration_s,
            }
            return

        from transformers import TextIteratorStreamer

        torch = self._torch
        loop = asyncio.get_running_loop()
        duration = float(audio.shape[0]) / self.settings.sample_rate
        mnt = max_new_tokens or self.settings.max_new_tokens
        t0 = time.time()

        sem = self._sem
        if sem is not None:
            await sem.acquire()
        try:
            tokenizer = getattr(self._processor, "tokenizer", None) or self._processor
            streamer = TextIteratorStreamer(
                tokenizer, skip_prompt=True, skip_special_tokens=False, timeout=120.0
            )

            inputs = await loop.run_in_executor(
                self._pool, lambda: self._to_device(self._build_inputs(audio, language))
            )

            err_box: List[BaseException] = []

            def _run() -> None:
                try:
                    with self._lock, torch.inference_mode():
                        self._model.generate(
                            **inputs, max_new_tokens=mnt, do_sample=False, streamer=streamer
                        )
                except BaseException as exc:  # noqa: BLE001
                    err_box.append(exc)
                    try:
                        streamer.end()
                    except Exception:
                        pass

            worker = threading.Thread(target=_run, name="asr-generate", daemon=True)
            worker.start()

            parser = TranscriptionStreamParser()
            it = iter(streamer)
            while True:
                piece = await loop.run_in_executor(None, lambda: next(it, _SENTINEL))
                if piece is _SENTINEL:
                    break
                delta = parser.feed(str(piece))
                if delta:
                    yield {"type": "delta", "text": delta}

            await loop.run_in_executor(None, worker.join)
            if err_box:
                raise err_box[0]

            tail = parser.finalize()
            if tail:
                yield {"type": "delta", "text": tail}

            infer_ms = (time.time() - t0) * 1000.0
            text = parser.text.strip()
            yield {
                "type": "final",
                "text": text,
                "language": parser.language,
                "infer_ms": round(infer_ms, 1),
                "duration_s": round(duration, 3),
                "rtf": round((infer_ms / 1000.0) / duration, 3) if duration > 0 else 0.0,
            }
        finally:
            if sem is not None:
                sem.release()


_engine: Optional[ASREngine] = None


def get_engine() -> ASREngine:
    if _engine is None:
        raise RuntimeError("引擎未初始化")
    return _engine


def set_engine(engine: Optional[ASREngine]) -> None:
    global _engine
    _engine = engine
