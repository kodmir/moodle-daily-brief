"""End-to-end runs against a fake Moodle and a fake Telegram: failure modes and the no-delete guarantees."""
import json
import re

import pytest

from conftest import DAY, FROZEN_TS, ts

NOW = FROZEN_TS


class FakeMoodle:
    """Configurable stand-in for the Moodle web service."""

    def __init__(self, mb):
        self.mb = mb
        self.mode = "ok"            # ok | net | token | partial
        self.courses = [
            {"id": 1, "shortname": "2026/2027-1 IE  202.01", "fullname": "OR I", "startdate": NOW - 60 * DAY, "enddate": NOW + 60 * DAY},
            {"id": 2, "shortname": "2026/2027-1 MATH101.01", "fullname": "Calculus", "startdate": NOW - 60 * DAY, "enddate": NOW + 60 * DAY},
            {"id": 3, "shortname": "2026/2027-1 MATH101.02", "fullname": "Calculus", "startdate": NOW - 60 * DAY, "enddate": NOW + 60 * DAY},
        ]
        # (discussion id, course id, subject, body, created)
        self.posts = [(101, 1, "Midterm", "The IE202 midterm will be held on November 17 at 17:00.", NOW - 5 * DAY)]
        self.replies = {}           # discussion id -> list of (post id, text, created)
        self.post_calls = 0

    def __call__(self, fn, **p):
        mb = self.mb
        if self.mode == "net":
            raise mb.TransientError("no connection")
        if self.mode == "token" and fn == "core_webservice_get_site_info":
            raise mb.TokenError("invalidtoken")
        if fn == "core_webservice_get_site_info":
            return {"userid": 7}
        if fn == "core_enrol_get_users_courses":
            return self.courses
        if fn == "core_course_get_contents":
            if self.mode == "partial":
                raise mb.MoodleError("core_course_get_contents: nopermission")
            return [{"id": 1, "summary": "", "modules": [
                {"id": 900 + p["courseid"], "modname": "feedback", "name": "Survey",
                 "dates": [{"label": "Opens:", "timestamp": NOW + DAY}, {"label": "Closes:", "timestamp": NOW + 2 * DAY}]}]}]
        if fn == "mod_forum_get_forums_by_courses":
            return [{"id": 50 + c["id"], "course": c["id"], "type": "news"} for c in self.courses]
        if fn == "mod_forum_get_forum_discussions":
            cid = p["forumid"] - 50
            out = []
            for did, c, subj, body, created in self.posts:
                if c == cid:
                    out.append({"discussion": did, "id": did * 10, "subject": subj, "message": body,
                                "created": created, "modified": created, "userfullname": "Instructor",
                                "numreplies": len(self.replies.get(did, []))})
            return {"discussions": out}
        if fn == "mod_forum_get_discussion_posts":
            self.post_calls += 1
            did = p["discussionid"]
            posts = [{"id": did * 10, "parentid": 0, "message": "first"}]
            posts += [{"id": pid, "parentid": did * 10, "message": t, "timecreated": cr, "author": {"fullname": "TA"}}
                      for pid, t, cr in self.replies.get(did, [])]
            return {"posts": posts}
        return {}


class FakeTelegram:
    def __init__(self):
        self.sent = []
        self.reject_html = False

    def __call__(self, url, json=None, timeout=None):
        class R:
            status_code, text = 200, ""

            def json(self):
                return {}
        r = R()
        if self.reject_html and "parse_mode" in json:
            r.status_code, r.text = 400, "can't parse entities"
            return r
        self.sent.append(json)
        return r

    @property
    def last(self):
        return self.sent[-1]["text"]


@pytest.fixture
def env(mb, monkeypatch):
    moodle, tg = FakeMoodle(mb), FakeTelegram()
    monkeypatch.setattr(mb.Moodle, "call", lambda _self, fn, **p: moodle(fn, **p))
    monkeypatch.setattr(mb.requests, "post", tg)
    return mb, moodle, tg


def run(mb, *args):
    import sys
    sys.argv = ["moodle_brief.py", *args]
    mb.WARNINGS.clear()
    try:
        mb.entry()
    except SystemExit as e:
        return e.code
    return 0


def new_day(mb):
    st = json.loads(mb.STATE_FILE.read_text())
    st["last_sent_date"] = "2000-01-01"
    mb.STATE_FILE.write_text(json.dumps(st))


def plain(t):
    return re.sub(r"</?[bi]>|<a [^>]*>|</a>", "", t)


def test_first_brief_content(env):
    mb, moodle, tg = env
    moodle.posts.append((201, 2, "Office hours", "Office hours moved to TB215.", NOW - 3600))
    moodle.posts.append((202, 3, "Office hours", "Office hours moved to TB215.", NOW - 3600))  # same post, 2nd section
    moodle.replies[101] = [(5001, "Correction: room is M2.", NOW - 1000)]
    assert run(mb, "run") == 0
    msg = plain(tg.last)
    assert "IE202" in msg and "2026/2027" not in msg                 # short course codes
    assert msg.count("MATH101 · Office hours") == 1                   # cross-section duplicate merged
    assert "Survey (kapanış)" in msg and "Survey (açılış)" not in msg  # survey "opens" is noise
    assert "Re: Midterm" in msg                                       # replies are read
    assert "17 Kas" in msg                                            # exam date extracted


def test_one_brief_per_day_and_reply_cache(env):
    mb, moodle, tg = env
    moodle.replies[101] = [(5001, "Room M2.", NOW - 1000)]
    run(mb, "run")
    calls = moodle.post_calls
    run(mb, "run", "--scheduled")
    assert len(tg.sent) == 1                                          # no second brief today
    new_day(mb)
    run(mb, "run", "--force")
    assert moodle.post_calls == calls                                 # unchanged thread not re-fetched
    assert "yeni bir şey yok" in tg.last


def test_newer_announcement_supersedes_older_date(env):
    mb, moodle, tg = env
    moodle.posts = [
        (101, 1, "IE202 Midterm Exam Announcement", "The IE202 Midterm Exam will be held on November 11, 17:00.", NOW - 50 * DAY),
        (102, 1, "Midterm Date Updated", "The exam date has been updated. The exam will be held on November 17, 17:00.", NOW - 30 * DAY),
    ]
    run(mb, "run")
    msg = plain(tg.last).split("📅")[0]
    assert "17 Kas" in msg and "11 Kas Çar 17:00" not in msg
    assert "eskisi 11 Kas" in msg


def test_edited_announcement_keeps_old_version(env):
    mb, moodle, tg = env
    run(mb, "run")
    archive_before = mb.ARCHIVE_FILE.read_text().splitlines()
    moodle.posts[0] = (101, 1, "Midterm", "The IE202 midterm moved to November 19 at 17:00.", NOW - 5 * DAY)
    new_day(mb)
    run(mb, "run", "--force")
    assert "güncellendi" in tg.last and "19 Kas" in tg.last
    st = json.loads(mb.STATE_FILE.read_text())
    prev = st["extracted"]["disc:101"]["previous_versions"]
    assert prev and prev[0]["events"][0]["date"] == "2026-11-17"     # old date kept, just not shown
    archive_after = mb.ARCHIVE_FILE.read_text().splitlines()
    assert archive_after[:len(archive_before)] == archive_before      # append-only
    assert len(archive_after) == len(archive_before) + 1


def test_removed_announcement_is_hidden_not_deleted(env):
    mb, moodle, tg = env
    moodle.posts.append((103, 1, "Quiz", "Quiz 3 on November 20.", NOW - DAY))
    run(mb, "run")
    moodle.posts = moodle.posts[:1]
    for _ in range(3):
        new_day(mb)
        run(mb, "run", "--force")
    st = json.loads(mb.STATE_FILE.read_text())
    assert st["extracted"]["disc:103"]["hidden"] is True               # still stored
    assert "KALDIRILANLAR" in tg.last
    assert "Quiz 3" not in tg.last.split("KALDIRILANLAR")[0]
    moodle.posts.append((103, 1, "Quiz", "Quiz 3 on November 20.", NOW - DAY))
    new_day(mb)
    run(mb, "run", "--force")
    st = json.loads(mb.STATE_FILE.read_text())
    assert not st["extracted"]["disc:103"].get("hidden")               # comes back if it reappears


def test_partial_outage_does_not_hide_records(env):
    mb, moodle, tg = env
    run(mb, "run")
    moodle.mode = "partial"
    for _ in range(4):
        new_day(mb)
        run(mb, "run", "--force")
    st = json.loads(mb.STATE_FILE.read_text())
    assert not any(e.get("hidden") for e in st["extracted"].values())


def test_network_failure_sends_nothing_and_keeps_state(env):
    mb, moodle, tg = env
    run(mb, "run")
    before = mb.STATE_FILE.read_text()
    moodle.mode = "net"
    new_day(mb)
    before = mb.STATE_FILE.read_text()
    n = len(tg.sent)
    assert run(mb, "run", "--scheduled") == 0                         # quiet: next retry is already scheduled
    assert len(tg.sent) == n
    assert mb.STATE_FILE.read_text() == before


def test_token_error_is_reported_once_per_day(env):
    mb, moodle, tg = env
    moodle.mode = "token"
    run(mb, "run", "--force")
    run(mb, "run", "--force")
    assert sum("token" in s["text"].lower() for s in tg.sent) == 1


def test_scheduled_run_waits_for_send_time(env):
    mb, moodle, tg = env
    mb.SEND_TIME = "23:59"
    run(mb, "run", "--scheduled")
    assert tg.sent == []
    mb.SEND_TIME = "07:00"
    run(mb, "run", "--scheduled")
    assert len(tg.sent) == 1


def test_local_copy_stands_down_when_cloud_is_active(env):
    mb, moodle, tg = env
    (mb.BASE_DIR / "CLOUD_ACTIVE").write_text("x")
    run(mb, "run", "--scheduled")
    assert tg.sent == []


def test_html_rejected_falls_back_to_plain_text(env):
    mb, moodle, tg = env
    tg.reject_html = True
    run(mb, "run")
    assert "parse_mode" not in tg.sent[-1] and "<b>" not in tg.last


def test_corrupt_state_recovers_from_backup(env):
    mb, moodle, tg = env
    run(mb, "run")
    new_day(mb)
    run(mb, "run", "--force")                                          # creates a backup
    mb.STATE_FILE.write_text("{broken")
    assert mb.load_state()["seen"]


def test_format_migration_does_not_flood_updates(env):
    mb, moodle, tg = env
    run(mb, "run")
    st = mb.load_state()
    st.pop("schema", None)
    st["seen"] = {k: "old-format" for k in st["seen"]}
    st["last_sent_date"] = "2000-01-01"
    mb.save_state(st)
    run(mb, "run", "--force")
    assert "güncellendi" not in tg.last


def test_concurrent_runs_are_locked(mb):
    lock = mb._acquire_lock()
    assert lock is not None and mb._acquire_lock() is None


def test_missing_config_is_explained(env):
    mb, moodle, tg = env
    mb.MOODLE_TOKEN = ""
    assert run(mb, "run", "--force") not in (0, None)
    assert "MOODLE_TOKEN" in mb.LOG_FILE.read_text()


@pytest.mark.parametrize("blob", [
    "moodle_token: 0123456789abcdef0123456789abcdef\ntelegram_bot_token: 1234567890:AAH_fake_example_token_value_00000000\ntelegram_chat_id: 1941487",
    "MOODLE_TOKEN=0123456789abcdef0123456789abcdef\nTELEGRAM_BOT_TOKEN=1234567890:AAH_fake_example_token_value_00000000\nTELEGRAM_CHAT_ID=1941487",
    "0123456789abcdef0123456789abcdef\n1234567890:AAH_fake_example_token_value_00000000\n1941487",
], ids=["key: value", "KEY=VALUE", "unlabelled"])
def test_single_secret_parsing(mb, monkeypatch, blob):
    for k in ("MOODLE_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("BRIEF_SECRETS", blob)
    mb._load_secret_blob()
    import os
    assert os.environ["MOODLE_TOKEN"] == "0123456789abcdef0123456789abcdef"
    assert os.environ["TELEGRAM_BOT_TOKEN"].startswith("1234567890:")
    assert os.environ["TELEGRAM_CHAT_ID"] == "1941487"


def test_course_short_names(mb):
    assert mb.short_course({"shortname": "2026/2027-1 IE  306.01"}) == "IE306"
    assert mb.short_course({"shortname": "2026/2027-1 MATH101.01"}) == "MATH101"
    assert mb.short_course({"shortname": "2026/2027-1 AD  216.01"}) == "AD216"


def test_titles_are_unescaped_once(mb):
    it = mb.mk("k", "x", "IE306", "Class &amp; Seating Plan")
    assert it["title"] == "Class & Seating Plan" and mb.E(it["title"]) == "Class &amp; Seating Plan"
