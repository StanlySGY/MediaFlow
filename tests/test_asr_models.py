from pathlib import Path

import httpx
import pytest
import respx


@pytest.fixture
async def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "runtime_config.json"))
    monkeypatch.setenv("ASR_BASE_URL", "https://file.example/v1")
    monkeypatch.setenv("ASR_API_KEY", "file-secret")
    monkeypatch.setenv("REALTIME_ASR_BASE_URL", "wss://realtime.example/v1/asr/stream")
    monkeypatch.setenv("REALTIME_ASR_API_KEY", "realtime-secret")
    monkeypatch.setenv("ACCESS_TOKENS", "")

    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app

    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c
    get_settings.cache_clear()


def _models_response() -> httpx.Response:
    return httpx.Response(200, json={"data": [{"id": "test-model"}]})


@respx.mock
async def test_custom_origin_does_not_receive_saved_key(client):
    route = respx.get("https://custom.example/v1/models").mock(
        return_value=_models_response(),
    )

    response = await client.get(
        "/asr/models", params={"base_url": "https://custom.example/v1"}
    )

    assert response.status_code == 400
    assert "保存到配置档案" in response.json()["detail"]
    assert not route.called


@respx.mock
async def test_matching_file_endpoint_uses_saved_key(client):
    route = respx.get("https://file.example/v1/models").mock(
        return_value=_models_response(),
    )

    response = await client.post(
        "/asr/models",
        json={"base_url": "HTTPS://FILE.EXAMPLE:443/v1/", "target": "file"},
    )

    assert response.status_code == 200
    assert route.calls[0].request.headers["authorization"] == "Bearer file-secret"


@respx.mock
async def test_explicit_key_is_limited_to_its_request(client):
    await client.get("/asr/profiles")
    saved_profile = await client.post(
        "/asr/profiles",
        json={"name": "Custom endpoint", "asr_base_url": "https://custom.example/v1"},
    )
    assert saved_profile.status_code == 200
    custom_route = respx.get("https://custom.example/v1/models").mock(
        return_value=_models_response(),
    )
    file_route = respx.get("https://file.example/v1/models").mock(
        return_value=_models_response(),
    )

    explicit = await client.post(
        "/asr/models",
        json={"base_url": "https://custom.example/v1", "api_key": "one-shot-key", "target": "file"},
    )
    without_explicit_key = await client.get(
        "/asr/models", params={"base_url": "https://custom.example/v1"}
    )
    configured = await client.post(
        "/asr/models", json={"base_url": "https://file.example/v1", "target": "file"}
    )

    assert explicit.status_code == without_explicit_key.status_code == configured.status_code == 200
    assert custom_route.calls[0].request.headers["authorization"] == "Bearer one-shot-key"
    assert "one-shot-key" not in str(custom_route.calls[0].request.url)
    assert custom_route.calls[1].request.headers.get("authorization") is None
    assert file_route.calls[0].request.headers["authorization"] == "Bearer file-secret"


@respx.mock
async def test_unconfigured_private_endpoint_is_not_probed(client):
    route = respx.get("http://127.0.0.1:2375/v1/models").mock(
        return_value=_models_response(),
    )

    response = await client.post(
        "/asr/models",
        json={"base_url": "http://127.0.0.1:2375/v1", "target": "file"},
    )

    assert response.status_code == 400
    assert "保存到配置档案" in response.json()["detail"]
    assert not route.called


@respx.mock
async def test_saved_private_asr_endpoint_can_be_probed(client):
    await client.get("/asr/profiles")
    saved_profile = await client.post(
        "/asr/profiles",
        json={"name": "On-prem ASR", "asr_base_url": "http://10.0.0.24:8022/v1"},
    )
    assert saved_profile.status_code == 200
    route = respx.get("http://10.0.0.24:8022/v1/models").mock(
        return_value=_models_response(),
    )

    response = await client.post(
        "/asr/models",
        json={"base_url": "http://10.0.0.24:8022/v1", "target": "file"},
    )

    assert response.status_code == 200
    assert response.json()["models"] == ["test-model"]
    assert route.called


@respx.mock
async def test_matching_realtime_websocket_endpoint_uses_saved_key(client):
    route = respx.get("https://realtime.example/v1/models").mock(
        return_value=_models_response(),
    )

    response = await client.post(
        "/asr/models",
        json={"base_url": "wss://realtime.example/v1/asr/stream", "target": "realtime"},
    )

    assert response.status_code == 200
    assert route.calls[0].request.headers["authorization"] == "Bearer realtime-secret"


@respx.mock
async def test_shared_endpoint_uses_the_selected_pipeline_key(client):
    from app.config import get_settings
    settings = get_settings()
    settings.realtime_asr_base_url = settings.asr_base_url
    settings.realtime_asr_api_key = "realtime-secret"
    route = respx.get("https://file.example/v1/models").mock(
        return_value=_models_response(),
    )

    file_response = await client.post(
        "/asr/models",
        json={"base_url": settings.asr_base_url, "target": "file"},
    )
    realtime_response = await client.post(
        "/asr/models",
        json={"base_url": settings.realtime_asr_base_url, "target": "realtime"},
    )

    assert file_response.status_code == realtime_response.status_code == 200
    assert route.calls[0].request.headers["authorization"] == "Bearer file-secret"
    assert route.calls[1].request.headers["authorization"] == "Bearer realtime-secret"
