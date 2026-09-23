"""Qwen3-ASR 只认语言全称。

官方实现（QwenLM/Qwen3-ASR qwen_asr/inference/utils.py 的
normalize_language_name）只做首字母大写，"zh" 会变成 "Zh"，再被
validate_language 按白名单拒绝。服务配置和上传接口里用户填的是 "zh" 这类
短码，所以这里先把常见 ISO 码翻成全称，再交给上游。

全称清单取自官方 SUPPORTED_LANGUAGES，别名取自 README 语言覆盖表里括号内的码。
"""
from __future__ import annotations

# 官方 SUPPORTED_LANGUAGES，原文照录，顺序一致。
QWEN3_ASR_LANGUAGES: tuple[str, ...] = (
    "Chinese", "English", "Cantonese", "Arabic", "German", "French",
    "Spanish", "Portuguese", "Indonesian", "Italian", "Korean", "Russian",
    "Thai", "Vietnamese", "Japanese", "Turkish", "Hindi", "Malay", "Dutch",
    "Swedish", "Danish", "Finnish", "Polish", "Czech", "Filipino", "Persian",
    "Greek", "Romanian", "Hungarian", "Macedonian",
)

# ISO 639 短码 -> 官方全称。已是全称的值不需要登记，归一化时原样保留。
_LANGUAGE_ALIASES: dict[str, str] = {
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "zh-hans": "Chinese",
    "cmn": "Chinese",
    "en": "English",
    "en-us": "English",
    "yue": "Cantonese",
    "ar": "Arabic",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese",
    "id": "Indonesian",
    "it": "Italian",
    "ko": "Korean",
    "ru": "Russian",
    "th": "Thai",
    "vi": "Vietnamese",
    "ja": "Japanese",
    "jp": "Japanese",
    "tr": "Turkish",
    "hi": "Hindi",
    "ms": "Malay",
    "nl": "Dutch",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "pl": "Polish",
    "cs": "Czech",
    "fil": "Filipino",
    "fa": "Persian",
    "el": "Greek",
    "ro": "Romanian",
    "hu": "Hungarian",
    "mk": "Macedonian",
}

_CANONICAL = {name.lower(): name for name in QWEN3_ASR_LANGUAGES}


def normalize_language(language: str | None) -> str:
    """把语言码归一成上游认识的全称。

    空串、空白和 "auto" 返回空串，表示不指定、让上游自动判断。
    已经是全称（大小写不限）的值归回官方写法；未知值只做首字母大写，
    留给上游自己决定接不接受。
    """
    key = (language or "").strip()
    if not key or key.lower() == "auto":
        return ""
    low = key.lower()
    mapped = _LANGUAGE_ALIASES.get(low)
    if mapped:
        return mapped
    return _CANONICAL.get(low, key[:1].upper() + key[1:])
