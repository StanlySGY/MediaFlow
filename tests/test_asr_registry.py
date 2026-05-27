import pytest

from app.config import Settings
from app.services.asr import OpenAICompatProvider, create_provider, list_providers


def test_default_provider_is_openai_compat():
    s = Settings(asr_api_key="k")
    p = create_provider(s)
    assert isinstance(p, OpenAICompatProvider)


def test_unknown_provider_raises():
    s = Settings(asr_api_key="k", asr_provider="does-not-exist")
    with pytest.raises(ValueError):
        create_provider(s)


def test_list_providers_includes_default():
    assert "openai_compat" in list_providers()
