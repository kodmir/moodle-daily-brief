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
        self.modules = []           # extra course modules for course 1
        self.assignments = []       # (id, name, duedate) for course 1
        self.calendar = []          # (id, name, timestart) for course 1
        self.grades = {}            # course id -> list of grade items
        self.grades_disabled = False
        self.grades_invalid = set()  # course ids where the grade report returns "invalidresponse"
        self.grades_table = {}       # course id -> gradereport_user_get_grades_table response

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
            mods = [{"id": 900 + p["courseid"], "modname": "feedback", "name": "Survey",
                     "dates": [{"label": "Opens:", "timestamp": NOW + DAY}, {"label": "Closes:", "timestamp": NOW + 2 * DAY}]}]
            if p["courseid"] == 1:
                mods += self.modules
            return [{"id": 1, "summary": "", "modules": mods}]
        if fn == "mod_assign_get_assignments":
            return {"courses": [{"id": 1, "assignments": [{"id": i, "name": n, "duedate": d, "intro": ""}
                                                          for i, n, d in self.assignments]}]}
        if fn == "core_calendar_get_calendar_events":
            return {"events": [{"id": i, "name": n, "courseid": 1, "timestart": t, "modulename": "assign", "description": ""}
                               for i, n, t in self.calendar]}
        if fn == "gradereport_user_get_grades_table":
            return self.grades_table.get(p["courseid"], {})
        if fn == "gradereport_user_get_grade_items":
            if self.grades_disabled:
                raise mb.MoodleError("gradereport_user_get_grade_items: nopermission")
            if p["courseid"] in self.grades_invalid:
                raise mb.MoodleError("gradereport_user_get_grade_items: invalidresponse — Invalid response value detected")
            return {"usergrades": [{"gradeitems": self.grades.get(p["courseid"], [])}]}
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


def test_local_copy_stands_down_when_cloud_is_active(env, monkeypatch):
    mb, moodle, tg = env
    (mb.BASE_DIR / "CLOUD_ACTIVE").write_text("x")
    run(mb, "run", "--scheduled")
    assert tg.sent == []                      # local (Mac) copy stays quiet
    monkeypatch.setattr(mb, "IN_CLOUD", True)
    run(mb, "run", "--scheduled")
    assert len(tg.sent) == 1                  # the cloud copy ignores the marker


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


REVIEW_POST = ("You can find your midterm grade on the Moodle page.<br>The silent midterm exam review session "
               "will be on Wednesday, November 11th, between 13.00-16.00 at EF102.")


def test_exam_review_session_is_not_listed_as_an_exam(env):
    mb, moodle, tg = env
    moodle.posts.append((301, 2, "Midterm Grades and Review Session Details", REVIEW_POST, NOW - 3600))
    run(mb, "run")
    exams = plain(tg.last).split("🎯")[1].split("📅")[0]
    assert "IE202" in exams and "17 Kas" in exams                     # the real upcoming midterm
    assert "MATH101" not in exams and "11 Kas" not in exams           # not the review session
    assert "İtiraz/inceleme" in plain(tg.last)                        # still listed, under its own label


def test_rule_change_rescans_stored_items_without_flooding(env):
    mb, moodle, tg = env
    moodle.posts.append((301, 2, "Midterm Grades and Review Session Details", REVIEW_POST, NOW - 3600))
    run(mb, "run")
    st = mb.load_state()                                              # as an older rule set stored it
    st["extracted"]["disc:301"]["events"] = [{"title": "x", "type": "midterm", "date": "2026-11-11", "time": "13:00",
                                              "certainty": "approximate", "detail": "metinden"}]
    st["extracted"]["disc:301"]["mode"] = "free5"
    st["last_sent_date"] = "2000-01-01"
    mb.save_state(st)
    run(mb, "run", "--force")
    assert [e["type"] for e in mb.load_state()["extracted"]["disc:301"]["events"]] == ["review"]
    assert "yeni bir şey yok" in tg.last and "güncellendi" not in tg.last


def test_is_exam_ignores_post_exam_sessions(mb):
    assert mb.is_exam({"type": "midterm", "title": "x"})
    assert mb.is_exam({"type": "course", "title": "Quiz 4"})
    assert mb.is_exam({"type": "class_change", "title": "The midterm is postponed to November 17"})
    assert not mb.is_exam({"type": "course", "title": "Exam 1 review and objections"})
    assert not mb.is_exam({"type": "review", "title": "The objection session for Quiz 1 will be held on Monday"})
    assert not mb.is_exam({"type": "scheduler", "title": "Meeting with your Teacher"})


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


# ---------------------------------------------------------------- v1.1: grades, de-duplication, "what changed"

def other_lines(msg):
    """Lines of the 'DİĞER' section."""
    part = plain(msg).split("DİĞER", 1)
    return [l for l in part[1].split("\n")[1:] if l.startswith("•")] if len(part) > 1 else []


def test_same_thing_is_listed_once(env):
    mb, moodle, tg = env
    run(mb, "run")
    due = NOW + 3 * DAY
    # one upload = resource module + its file; one assignment = module + assignment API + calendar entry
    moodle.modules = [
        {"id": 700, "modname": "resource", "name": "Answers to 4th Exercise",
         "contents": [{"type": "file", "filename": "answers.docx", "filepath": "/", "filesize": 10, "timemodified": NOW}]},
        {"id": 701, "modname": "assign", "name": "Homework 5", "dates": [{"label": "Due:", "timestamp": due}]},
        {"id": 702, "modname": "folder", "name": "Problem Sets", "contents": [
            {"type": "file", "filename": "PS7.pdf", "filepath": "/", "filesize": 1, "timemodified": NOW},
            {"type": "file", "filename": "PS8.pdf", "filepath": "/", "filesize": 1, "timemodified": NOW}]},
    ]
    moodle.assignments = [(55, "Homework 5", due)]
    moodle.calendar = [(66, "Homework 5 is due", due)]
    new_day(mb)
    run(mb, "run", "--force")
    lines = other_lines(tg.last)
    assert sum("Answers to 4th Exercise" in l for l in lines) == 1
    assert sum("Homework 5" in l for l in lines) == 1
    assert any("ödev: Homework 5" in l for l in lines)                 # the assignment wins over module/calendar
    assert sum("Problem Sets" in l for l in lines) == 2                # two different files stay separate
    assert not any("etkinlik (" in l for l in lines)                   # readable type names


def test_update_shows_what_changed(env):
    mb, moodle, tg = env
    label = {"id": 710, "modname": "label", "name": "Recordings",
             "description": "<p>Recordings</p><p>(ENG) R1 R2 R3 R4 R5 R6 R7</p><p>(TUR) R1 R2 R3 R4 R5 R6 R7</p>"}
    moodle.modules = [label]
    run(mb, "run")
    label["description"] = "<p>Recordings</p><p>(ENG) R1 R2 R3 R4 R5 R6 R7 R8</p><p>(TUR) R1 R2 R3 R4 R5 R6 R7 R8</p>"
    new_day(mb)
    run(mb, "run", "--force")
    line = [l for l in other_lines(tg.last) if "Recordings" in l][0]
    assert "+ R8" in line and "sayfa metni" in line and "güncellendi" not in line


def test_label_titles_are_shortened(mb):
    it = {"kind": "etkinlik (label)", "title": "Recordings(ENG) R1 R2 R3 R4 R5 R6 R7 R8(TUR) R1 R2..."}
    assert mb.short_title(it) == "Recordings"
    assert mb.short_title({"kind": "etkinlik (label)", "title": "PS Schedule: Mondays and Thursdays"}) == "PS Schedule"
    assert mb.short_title({"kind": "dosya", "title": "Problem Sets / PS7.pdf"}) == "Problem Sets / PS7.pdf"


def test_diff_summary(mb):
    old = "PS6: Monday (cancelled)\nThursday 15-17 at EF106"
    assert mb.diff_summary(old, "PS7: Monday (cancelled)\nThursday 15-17 at EF106") == "PS7: Monday (cancelled)"
    assert mb.diff_summary("a line here", "a line here") == ""
    assert mb.diff_summary(None, "x") == ""
    assert mb.diff_summary("Room: M1100 and", "Room: M1100 and M1170") == "+ M1170"


def grade(i, name, raw, graded, mx=100, fb=""):
    return {"id": i, "itemname": name, "itemtype": "mod", "graderaw": raw, "gradeformatted": f"{raw:.2f}",
            "grademax": mx, "feedback": fb, "gradedategraded": graded}


def test_new_grade_is_reported_but_old_grades_do_not_flood(env):
    mb, moodle, tg = env
    run(mb, "run")                                                     # state exists, no grades tracked yet
    moodle.grades = {1: [grade(1, "Quiz 1", 70, NOW - 20 * DAY), grade(2, "Quiz 2", 85, NOW - 3600, fb="<p>Well done</p>"),
                         {"id": 3, "itemname": "Final", "itemtype": "mod", "graderaw": None},
                         {"id": 4, "itemname": "Course total", "itemtype": "course", "graderaw": 77.5}]}
    new_day(mb)
    run(mb, "run", "--force")
    msg = plain(tg.last)
    assert "YENİ NOTLAR (1)" in msg and "IE202 Quiz 2: 85/100" in msg and "Well done" in msg
    assert "Quiz 1" not in msg and "Course total" not in msg           # old grade and totals stay quiet
    moodle.grades[1][0] = grade(1, "Quiz 1", 75, NOW - 60)             # an objection changed the grade
    new_day(mb)
    run(mb, "run", "--force")
    assert "IE202 Quiz 1: 75/100 (değişti)" in plain(tg.last)


def test_grades_api_disabled_is_harmless(env):
    mb, moodle, tg = env
    moodle.grades_disabled = True
    assert run(mb, "run") == 0 and "17 Kas" in tg.last


def test_grade_formatting(mb):
    assert mb.fmt_grade({"gradeformatted": "85.00", "graderaw": 85, "grademax": 100}) == "85/100"
    assert mb.fmt_grade({"gradeformatted": "8,50", "graderaw": 8.5, "grademax": 10}) == "8.5/10"
    assert mb.fmt_grade({"gradeformatted": "BA", "graderaw": 3.5, "grademax": 4}) == "BA"


GRADES_TABLE = {"tables": [{"tabledata": [
    {"itemname": {"class": "level1 category", "content": "<span>IE 202</span>", "id": "cat_1_7"}},
    {"itemname": {"class": "level2 item", "content": '<a href="#">Quiz 2</a>', "id": "row_901_7"},
     "grade": {"content": "85,00"}, "range": {"content": "0&ndash;100"}, "feedback": {"content": "<p>Good</p>"}},
    {"itemname": {"class": "level2 item", "content": "Midterm", "id": "row_902_7"}, "grade": {"content": "-"}},
    {"itemname": {"class": "level1 baggt", "content": "Course total", "id": "row_999_7"}, "grade": {"content": "60.00"}},
    [], None,
]}]}


def test_grades_table_parsing(mb):
    rows = mb.grades_from_table(GRADES_TABLE)
    assert [(r["id"], r["itemname"], mb.fmt_grade(r)) for r in rows] == [("901", "Quiz 2", "85/100")]
    assert mb.grades_from_table(None) == [] and mb.grades_from_table({"tables": [{}]}) == []


def test_grade_report_invalidresponse_falls_back_to_table(env):
    """Some courses make Moodle's grade-items report fail; grades are then read from the grades table."""
    mb, moodle, tg = env
    run(mb, "run")
    moodle.grades_invalid = {1}
    moodle.grades_table = {1: GRADES_TABLE}
    new_day(mb)
    assert run(mb, "run", "--force") == 0
    st = json.loads(mb.STATE_FILE.read_text())
    assert "grade:1:901" in st["extracted"]                            # same key as the normal report would give
    assert "17 Kas" in tg.last                                         # rest of the brief unaffected

