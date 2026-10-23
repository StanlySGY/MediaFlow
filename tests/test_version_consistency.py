from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

# The release convention (stated at the top of CHANGELOG.md) is that one version
# number appears in four places. Nothing enforced it: CHANGELOG itself records a
# drift, where 1.3.1 showed up in frontend/package.json only and build.sh,
# app/main.py and docker-compose.prod.yml never followed it, so 1.3.1 is not even
# listed as a release. A mismatch is invisible until a site is handed
# mediaflow:1.8.4 while the docs describe a different build.
ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _fastapi_version() -> str:
    src = (ROOT / "app" / "main.py").read_text(encoding="utf-8")
    m = re.search(r'version="([^"]+)"', src)
    assert m, "no FastAPI version= in app/main.py"
    return m.group(1)


def _package_version() -> str:
    return json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"]


def _build_sh_tag() -> str:
    src = (ROOT / "build.sh").read_text(encoding="utf-8")
    m = re.search(r'^DEFAULT_TAG="([^"]+)"', src, re.MULTILINE)
    assert m, "no DEFAULT_TAG in build.sh"
    return m.group(1)


def _compose_image_tag() -> str:
    src = (ROOT / "docker-compose.prod.yml").read_text(encoding="utf-8")
    m = re.search(r"^\s*image:\s*mediaflow:([^\s]+)", src, re.MULTILINE)
    assert m, "no mediaflow image tag in docker-compose.prod.yml"
    return m.group(1)


def _changelog_latest() -> str:
    src = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    m = re.search(r"^## \[(\d+\.\d+\.\d+)\]", src, re.MULTILINE)
    assert m, "no versioned entry in CHANGELOG.md"
    return m.group(1)


def test_release_version_matches_all_four_landing_points():
    values = {
        "app/main.py": _fastapi_version(),
        "frontend/package.json": _package_version(),
        "build.sh DEFAULT_TAG": _build_sh_tag(),
        "docker-compose.prod.yml image": _compose_image_tag(),
    }
    assert len(set(values.values())) == 1, f"version drift: {values}"
    version = next(iter(values.values()))
    assert SEMVER.match(version), f"not a x.y.z version: {version}"


def test_changelog_top_entry_matches_the_build_tag():
    # The tag is what a site actually loads; the changelog is what an operator
    # reads before loading it. These disagreeing is how a delivered image ends up
    # undocumented.
    assert _changelog_latest() == _build_sh_tag()


@pytest.mark.parametrize("name,getter", [
    ("app/main.py", _fastapi_version),
    ("frontend/package.json", _package_version),
    ("build.sh", _build_sh_tag),
    ("docker-compose.prod.yml", _compose_image_tag),
    ("CHANGELOG.md", _changelog_latest),
])
def test_each_landing_point_is_readable(name: str, getter):
    assert SEMVER.match(getter()), f"{name} does not expose a x.y.z version"
