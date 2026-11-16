"""Fuzz: the whole pipeline against hostile text and malformed Moodle responses.

Whatever Moodle sends, a run must end in one of two ways: a brief is sent (records that cannot be read are
skipped), or the run stops as a transient failure to be retried. It must never crash, and what it sends must
be valid Telegram HTML within the message size limit. Seeds are fixed, so a failure is reproducible.
"""
import random
import re

import pytest

from conftest import DAY, FROZEN_TS
from test_scenarios import FakeTelegram, run  # noqa: F401

NOW = FROZEN_TS
NASTY = ["<b>bold", "a & b", "</b></i>", "<a href=\"x\">", "Tom & Jerry <3", "x" * 5000, "", "   ", "\n\n\n", "İŞĞÜÖÇ ığüşöç", "🎯🔥", "&amp;amp;", "&#99999999;", "&#x110000;", "<script>alert(1)</script>",
         "Midterm on November 9 at 17:00 in M100", "Quiz 31.02.2026", "due 99/99/9999", "00:00", "24:61", "‮\u0000evil", "a\tb\rc", "%s %d {0} ${x}", "'; DROP TABLE--", "https://x.y/?a=1&b=2\"onload=\"x",
         "Final exam: 5 Ocak 2027 Salı 09:00", "1.1.1.1", "..//..", "🏳️‍🌈" * 50, "tomorrow tomorrow tomorrow", "next next Monday", "0/0", "-1", "9" * 40, "Re: " * 30, "‮‭", "\\", "<<<>>>", "&lt;b&gt;"]
def rich(rnd):
    def txt(): return rnd.choice(["The midterm will be held on November 17 at 17:00, in M100.", "<p>Homework 3 is due <b>November 9</b> , 23:59.</p>", "Quiz 2 on Monday.", "Dear all,<br>no class tomorrow.",
                                  "Vize 25 Kasım Çarşamba 18:00", "Slides uploaded.", "The objection session will be on November 10 at 15:00.", rnd.choice(NASTY)])
    courses = [{"id": i, "shortname": f"2026/2027-1 {c}.0{i}", "fullname": c, "startdate": NOW - 60 * DAY, "enddate": NOW + 60 * DAY} for i, c in enumerate(["IE  202", "MATH101", "AD 216", "IE 306"], 1)]
    def mods(cid):
        out = []
        for j in range(rnd.randint(0, 6)):
            mn = rnd.choice(["resource", "assign", "quiz", "feedback", "label", "url", "folder", "forum", "page", "scheduler"])
            out.append({"id": cid * 1000 + j, "modname": mn, "name": rnd.choice(["Slides " + str(j), "Homework " + str(j), "Quiz " + str(j), txt()]), "description": txt() if rnd.random() < .5 else None,
                        "url": "https://m/mod/view.php?id=%d" % (cid * 1000 + j),
                        "dates": [{"label": rnd.choice(["Opens:", "Closes:", "Due:", "Opened:", "Kapanıyor:"]), "timestamp": NOW + rnd.randint(-3, 9) * DAY, "dataid": rnd.choice(["duedate", "timeopen", "timeclose", "", None])} for _ in range(rnd.randint(0, 2))],
                        "contents": [{"type": "file", "filename": f"f{j}_{k}.pdf", "fileurl": "https://m/f.pdf", "filesize": 1000 + k, "timemodified": NOW - k * DAY} for k in range(rnd.randint(0, 3))]})
        return out
    R = {
        "core_webservice_get_site_info": lambda p: {"userid": 7, "fullname": "T"},
        "core_enrol_get_users_courses": lambda p: courses,
        "core_course_get_contents": lambda p: [{"id": s, "name": "Week %d" % s, "summary": txt() if rnd.random() < .3 else "", "modules": mods(p["courseid"])} for s in range(rnd.randint(1, 3))],
        "mod_assign_get_assignments": lambda p: {"courses": [{"id": c["id"], "assignments": [{"id": c["id"] * 10 + a, "cmid": 1, "name": "Homework %d" % a, "duedate": NOW + rnd.randint(-2, 12) * DAY, "intro": txt(), "allowsubmissionsfromdate": NOW - DAY} for a in range(rnd.randint(0, 3))]} for c in courses]},
        "mod_assign_get_submission_status": lambda p: {"lastattempt": {"submission": {"status": rnd.choice(["submitted", "new", "draft"])}}},
        "mod_quiz_get_quizzes_by_courses": lambda p: {"quizzes": [{"id": q, "course": rnd.randint(1, 4), "coursemodule": q, "name": "Quiz %d" % q, "intro": txt(), "timeopen": NOW + rnd.randint(-2, 5) * DAY, "timeclose": NOW + rnd.randint(0, 9) * DAY} for q in range(rnd.randint(0, 3))]},
        "core_calendar_get_calendar_events": lambda p: {"events": [{"id": e, "name": rnd.choice(["Homework 1 is due", "Quiz 1 opens", "Meeting", txt()]), "courseid": rnd.randint(0, 4), "timestart": NOW + rnd.randint(-1, 20) * DAY, "modulename": rnd.choice(["assign", "quiz", "", None]), "eventtype": rnd.choice(["due", "course", "user"]), "description": txt(), "instance": e} for e in range(rnd.randint(0, 5))]},
        "mod_forum_get_forums_by_courses": lambda p: [{"id": 50 + c["id"], "course": c["id"], "type": rnd.choice(["news", "general"]), "name": "Announcements"} for c in courses],
        "mod_forum_get_forum_discussions": lambda p: {"discussions": [] if p.get("page") else [{"discussion": p["forumid"] * 100 + d, "id": p["forumid"] * 1000 + d, "subject": rnd.choice(["Midterm", "Quiz 2 Date", txt()]), "message": txt(), "created": NOW - rnd.randint(0, 20) * DAY, "modified": NOW - rnd.randint(0, 3) * DAY, "userfullname": rnd.choice(["Instructor", rnd.choice(NASTY)]), "numreplies": rnd.randint(0, 2), "attachments": [{"filename": "a.pdf", "fileurl": "https://m/a.pdf", "filesize": 5, "timemodified": NOW}] if rnd.random() < .2 else []} for d in range(rnd.randint(0, 5))]},
        "mod_forum_get_discussion_posts": lambda p: {"posts": [{"id": p["discussionid"] * 10, "parentid": 0, "message": "first"}] + [{"id": p["discussionid"] * 10 + r, "parentid": p["discussionid"] * 10, "subject": "Re: x", "message": txt(), "timecreated": NOW - r * 3600, "author": {"fullname": "TA"}} for r in range(1, rnd.randint(1, 3))]},
        "message_popup_get_popup_notifications": lambda p: {"notifications": [{"id": n, "subject": rnd.choice(["2026/2027-1 IE  202.01: Midterm", txt()]), "smallmessage": txt(), "fullmessage": txt(), "timecreated": NOW - n * 3600, "contexturl": "https://m/x"} for n in range(rnd.randint(0, 5))]},
        "core_message_get_conversations": lambda p: {"conversations": [{"id": c, "name": "x", "members": [{"fullname": "Prof"}], "messages": [{"id": c * 10, "text": txt(), "timecreated": NOW - c * 3600, "useridfrom": 9}]} for c in range(rnd.randint(0, 2))]},
        "gradereport_user_get_grade_items": lambda p: {"usergrades": [{"gradeitems": [{"id": p["courseid"] * 100 + g, "itemname": rnd.choice(["Midterm", "Quiz 1", txt()]), "itemtype": "mod", "graderaw": rnd.choice([85, 28.5, None, 0]), "gradeformatted": rnd.choice(["85.00", "28.50", "-", "AA", ""]), "grademax": rnd.choice([100, 40, 0, None]), "gradedategraded": NOW - g * DAY, "feedback": txt() if rnd.random() < .3 else "", "averageformatted": rnd.choice(["61.20", "-", None])} for g in range(rnd.randint(0, 3))]}]},
        "gradereport_user_get_grades_table": lambda p: {"tables": [{"tabledata": [{"itemname": {"class": "level2 item", "id": "row_55_7", "content": "<span>Exam 1</span>"}, "grade": {"content": "31.00"}, "range": {"content": "0&ndash;100"}, "feedback": {"content": ""}}]}]},
    }
    return R
JUNK = [None, "", 0, -1, 10 ** 15, [], {}, "x", 3.7, True, ["x"], {"a": 1}, "9" * 30, float("nan")]
def mutate(o, rnd, p):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            r = rnd.random()
            if r < p / 2: continue
            out[k] = rnd.choice(JUNK + NASTY) if r < p else mutate(v, rnd, p)
        return out
    if isinstance(o, list):
        if rnd.random() < p / 3: return rnd.choice(JUNK)
        return [mutate(v, rnd, p) for v in o]
    if rnd.random() < p / 2: return rnd.choice(JUNK + NASTY)
    return o
OKTAG = re.compile(r"<b>|</b>|<i>|</i>|<a href=\"[^\"<>]*\">|</a>")
def html_ok(t):
    rest = OKTAG.sub("", t)
    if "<" in rest or ">" in rest: return "stray < or >"
    if re.search(r"&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)", rest): return "bare &"
    for line in t.split("\n"):
        st = []
        for tag in OKTAG.findall(line):
            if tag.startswith("</"):
                if not st or st.pop() != tag[2:-1]: return "unbalanced " + tag
            else: st.append("a" if tag.startswith("<a") else tag[1:-1])
        if st: return "unclosed <%s> within a line" % st[-1]
    return None


def check_messages(sent):
    for s in sent:
        t = s.get("text") or ""
        assert len(t) <= 4096
        if s.get("parse_mode") == "HTML":
            assert html_ok(t) is None, (html_ok(t), [l for l in t.split("\n") if html_ok(l)][:1])


@pytest.mark.parametrize("rate", [0.0, 0.03, 0.12])
def test_pipeline_survives_anything_moodle_sends(mb, monkeypatch, rate):
    tg = FakeTelegram()
    monkeypatch.setattr(mb.requests, "post", tg)
    for seed in range(25):
        rnd = random.Random(seed * 1000 + int(rate * 100))
        for f in (mb.STATE_FILE, mb.BACKUP_FILE, mb.ARCHIVE_FILE):
            if f.exists():
                f.unlink()                              # every seed starts from an empty history
        for _ in range(2):                              # second run: "updated" items, diffs, hiding
            resp = rich(rnd)
            monkeypatch.setattr(mb.Moodle, "call",
                                lambda _s, fn, **p: mutate(resp[fn](p), rnd, rate) if fn in resp else {})
            tg.sent.clear()
            if mb.LOG_FILE.exists():
                mb.LOG_FILE.unlink()
            code = run(mb, "run", "--force")
            log = mb.LOG_FILE.read_text()
            controlled = "Geçici hata" in log
            assert controlled or (code == 0 and tg.sent), f"seed {seed}, rate {rate}: {log[-600:]}"
            assert not any("çalışmadı:" in (s.get("text") or "") for s in tg.sent), f"seed {seed}: crash reported"
            check_messages(tg.sent)


def test_validator_rejects_broken_markup():
    """The checker used above is not vacuous."""
    assert html_ok("• <b>IE202</b> <a href=\"https://x/?a=1&amp;b=2\">t</a> &lt;3") is None
    assert html_ok("<b>unclosed") and html_ok("a < b") and html_ok("Tom & Jerry") and html_ok("</i>x")
