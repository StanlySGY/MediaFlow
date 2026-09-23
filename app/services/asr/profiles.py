"""Named ASR endpoint profiles.

The console keeps one flat set of ASR settings, which means it can only point
at a single upstream. A profile bundles the fields that describe one upstream
(provider, address, key, model, language, biasing hints) so several can be
saved and the file / realtime pipelines can each pick one.

The legacy flat fields on Settings stay the source of truth for everything
that already reads them. Profiles are stored alongside them in the runtime
config and copied onto those fields for whichever pipeline is active, so no
call site has to learn about profiles.
"""
from __future__ import annotations

import re
import uuid

# Connection fields that belong to a profile rather than to the process.
PROFILE_FIELDS: tuple[str, ...] = (
    "asr_provider",
    "asr_base_url",
    "asr_api_key",
    "asr_model",
    "asr_language",
    "asr_hotwords",
    "asr_prompt_hints",
    "asr_timestamps",
    "asr_timeout",
)

# Realtime has its own address and key; everything else is shared with the
# file pipeline, so a profile used for realtime maps these across.
_REALTIME_MAP: dict[str, str] = {
    "asr_provider": "realtime_asr_provider",
    "asr_base_url": "realtime_asr_base_url",
    "asr_api_key": "realtime_asr_api_key",
    "asr_model": "realtime_asr_model",
}

_NAME_LIMIT = 40


def new_profile_id() -> str:
    return uuid.uuid4().hex[:8]


def clean_name(name: object) -> str:
    text = re.sub(r"\s+", " ", str(name or "")).strip()
    if not text:
        raise ValueError("配置名称不能为空")
    if len(text) > _NAME_LIMIT:
        raise ValueError(f"配置名称不能超过 {_NAME_LIMIT} 个字")
    return text


def profile_from_settings(settings: object, *, name: str, profile_id: str | None = None) -> dict:
    """Snapshot the current flat settings into a profile."""
    return {
        "id": profile_id or new_profile_id(),
        "name": name,
        **{field: getattr(settings, field) for field in PROFILE_FIELDS},
    }


def public_profile(profile: dict) -> dict:
    """The profile as the API returns it: the key is never echoed, only whether it is set."""
    out = {k: v for k, v in profile.items() if k != "asr_api_key"}
    out["api_key_set"] = bool(profile.get("asr_api_key"))
    return out


def apply_profile(settings: object, profile: dict, *, target: str) -> dict:
    """Copy a profile onto the flat settings fields of one pipeline.

    Returns the flat-field updates, so the caller can persist them the same way
    as any other runtime override.
    """
    if target not in ("file", "realtime"):
        raise ValueError(f"unknown profile target: {target}")
    mapping = _REALTIME_MAP if target == "realtime" else {f: f for f in PROFILE_FIELDS}
    updates: dict = {}
    for src, dest in mapping.items():
        if src in profile:
            setattr(settings, dest, profile[src])
            updates[dest] = profile[src]
    return updates
