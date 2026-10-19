"""Named ASR endpoint profiles.

Each profile stores independent endpoint settings for file and realtime ASR,
so the two pipelines can use their own provider namespaces and credentials.

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

REALTIME_PROFILE_FIELDS: tuple[str, ...] = (
    "realtime_asr_provider",
    "realtime_asr_base_url",
    "realtime_asr_api_key",
    "realtime_asr_model",
)
ALL_PROFILE_FIELDS: tuple[str, ...] = PROFILE_FIELDS + REALTIME_PROFILE_FIELDS
REALTIME_PROFILE_DEFAULTS: dict[str, str] = {
    "realtime_asr_provider": "realtime_mock",
    "realtime_asr_base_url": "",
    "realtime_asr_api_key": "",
    "realtime_asr_model": "",
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
        **{field: getattr(settings, field) for field in ALL_PROFILE_FIELDS},
    }


def public_profile(profile: dict) -> dict:
    """The profile as the API returns it: the key is never echoed, only whether it is set."""
    out = {
        k: v for k, v in profile.items()
        if k not in ("asr_api_key", "realtime_asr_api_key")
    }
    out["api_key_set"] = bool(profile.get("asr_api_key"))
    out["realtime_api_key_set"] = bool(profile.get("realtime_asr_api_key"))
    return out


def apply_profile(settings: object, profile: dict, *, target: str) -> dict:
    """Copy a profile onto the flat settings fields of one pipeline.

    Returns the flat-field updates, so the caller can persist them the same way
    as any other runtime override.
    """
    updates = profile_updates(profile, target=target)
    for field, value in updates.items():
        setattr(settings, field, value)
    return updates


def profile_updates(profile: dict, *, target: str) -> dict:
    """Return the flat settings changes for a profile without applying them."""
    if target not in ("file", "realtime"):
        raise ValueError(f"unknown profile target: {target}")
    fields = REALTIME_PROFILE_FIELDS if target == "realtime" else PROFILE_FIELDS
    return {field: profile[field] for field in fields if field in profile}
