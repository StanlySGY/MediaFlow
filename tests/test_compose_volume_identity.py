from __future__ import annotations

import re
from pathlib import Path

import pytest

# The image runs as uid 10001 and the three data directories are host bind
# mounts, so startup refuses to run when they are not writable (1.8.0). The
# documented escape hatch is MEDIAFLOW_UID / MEDIAFLOW_GID, but only
# docker-compose.yml had the `user:` line that reads them — docker-compose.prod.yml,
# the file actually shipped to the site, did not. Measured on this host, whose
# .env sets MEDIAFLOW_UID=1000: `./build.sh --up` (which starts the prod file)
# crash-looped with "data volume(s) outputs, temp, config are not writable by
# uid 10001" even though the .env asked for the right identity and
# docker-compose.yml would have honoured it. Both files must take the same knob.
ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILES = ["docker-compose.yml", "docker-compose.prod.yml"]
USER_LINE = re.compile(
    r"^\s*user:\s*\"?\$\{MEDIAFLOW_UID:-10001\}:\$\{MEDIAFLOW_GID:-10001\}\"?\s*$",
    re.MULTILINE,
)


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_both_compose_files_honour_the_bind_mount_identity(name: str):
    src = (ROOT / name).read_text(encoding="utf-8")
    assert USER_LINE.search(src), (
        f"{name} has no user: line honouring MEDIAFLOW_UID / MEDIAFLOW_GID; "
        "a host whose data dirs are owned by another uid can only start it via chown"
    )


def test_env_example_documents_the_identity_knob():
    src = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert "MEDIAFLOW_UID" in src and "MEDIAFLOW_GID" in src


def test_no_data_volume_permission_instructions_depend_on_only_one_route():
    # Every doc that tells an operator to chown must also mention the alternative,
    # because the sites that cannot chown are exactly the ones that fail here.
    docs = ["README.md", "README.en.md", "DEPLOY_ONSITE.md", "ONSITE_DEPLOY.md"]
    for name in docs:
        src = (ROOT / name).read_text(encoding="utf-8")
        if "chown" not in src:
            continue
        assert "MEDIAFLOW_UID" in src, f"{name} prescribes chown with no alternative"
