"""Shared fixtures: a fresh copy of the module per test, a frozen clock, and an isolated data/ dir."""
import importlib
import os
import sys
from datetime import datetime as _dt
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Free mode (no Claude API) and no real credentials, before the module is imported.
for k in ("ANTHROPIC_API_KEY", "BRIEF_SECRETS", "MOODLE_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
    os.environ.pop(k, None)
os.environ["ANTHROPIC_API_KEY"] = ""

import moodle_brief  # noqa: E402

TZ = moodle_brief.TZ
# "Today" for every test: Thursday 5 Nov 2026, 10:00 Istanbul
FROZEN = _dt(2026, 11, 5, 10, 0, tzinfo=TZ)
FROZEN_TS = int(FROZEN.timestamp())
DAY = 86400


class FrozenDatetime(_dt):
    @classmethod
    def now(cls, tz=None):
        return FROZEN.astimezone(tz) if tz else FROZEN.replace(tzinfo=None)


def ts(y, mo, d, h=0, mi=0) -> int:
    return int(_dt(y, mo, d, h, mi, tzinfo=TZ).timestamp())


@pytest.fixture
def mb(tmp_path, monkeypatch):
    """moodle_brief, reloaded (clean globals), with frozen time and data/ in a temp dir."""
    m = importlib.reload(moodle_brief)
    monkeypatch.setattr(m, "datetime", FrozenDatetime)
    monkeypatch.setattr(m.time, "time", lambda: FROZEN_TS)
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    data = tmp_path / "data"
    monkeypatch.setattr(m, "DATA_DIR", data)
    monkeypatch.setattr(m, "STATE_FILE", data / "state.json")
    monkeypatch.setattr(m, "BACKUP_FILE", data / "state.bak.json")
    monkeypatch.setattr(m, "LOG_FILE", data / "log.txt")
    monkeypatch.setattr(m, "ARCHIVE_FILE", data / "archive.jsonl")
    monkeypatch.setattr(m, "BASE_DIR", tmp_path)
    m.MOODLE_TOKEN, m.TG_TOKEN, m.TG_CHAT = "test-token", "123:abc", "42"
    m.WARNINGS.clear()
    return m
