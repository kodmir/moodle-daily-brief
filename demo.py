#!/usr/bin/env python3
"""Offline demo: runs the real pipeline against a FAKE Moodle (fictional courses and announcements)
and prints the brief instead of sending it. No accounts, tokens or network needed.

    python demo.py
"""
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

os.environ["ANTHROPIC_API_KEY"] = ""
for k in ("BRIEF_SECRETS", "MOODLE_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
    os.environ.pop(k, None)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import moodle_brief as mb  # noqa: E402

EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
             "October", "November", "December"]
now = int(time.time())
today = datetime.now(mb.TZ)
D = 86400


def en(days: int) -> str:
    d = today + timedelta(days=days)
    return f"{EN_MONTHS[d.month - 1]} {d.day}"


COURSES = [
    {"id": 1, "shortname": "2026/2027-1 IE  310.01", "fullname": "Operations Research II"},
    {"id": 2, "shortname": "2026/2027-1 EC  204.01", "fullname": "Intermediate Microeconomics"},
    {"id": 3, "shortname": "2026/2027-1 MATH201.01", "fullname": "Matrix Theory"},
]
for c in COURSES:
    c.update(startdate=now - 60 * D, enddate=now + 60 * D)

POSTS = {  # course id -> [(discussion id, subject, body, created)]
    1: [(11, "Midterm Exam Announcement", f"The IE310 midterm will be held on {en(4)}, 17:00-19:00.", now - 30 * D),
        (12, "Midterm Date Updated", f"Dear all, the midterm date has been updated. The exam will be held on {en(9)}, "
                                     f"from 17:00 to 19:00, in M2. Seat assignments will be announced later.", now - 2 * D)],
    2: [(21, "Problem Set 4", f"PS4 is uploaded. It is due {en(2)} at 23:59 via Moodle.", now - 3 * 3600),
        (22, "Quiz 1 grades", "Quiz 1 grades are announced. Objections until Friday.", now - 5 * 3600)],
    3: [(31, "Tomorrow's lecture is cancelled", "Tomorrow's lecture is cancelled. Make-up lecture will be scheduled later.",
         now - 2 * 3600)],
}


def fake_call(self, fn, **p):
    if fn == "core_webservice_get_site_info":
        return {"userid": 1}
    if fn == "core_enrol_get_users_courses":
        return COURSES
    if fn == "core_course_get_contents":
        if p["courseid"] == 1:
            return [{"id": 1, "summary": "", "modules": [
                {"id": 101, "modname": "assign", "name": "Homework 3", "dates": [{"label": "Due:", "timestamp": int((today + timedelta(days=5)).replace(hour=0, minute=0).timestamp())}]},
                {"id": 102, "modname": "resource", "name": "Lecture 9 slides",
                 "contents": [{"type": "file", "filename": "lecture9.pdf", "filesize": 1000, "timemodified": now - 3600, "fileurl": "x"}]}]}]
        return []
    if fn == "mod_forum_get_forums_by_courses":
        return [{"id": 100 + c["id"], "course": c["id"], "type": "news"} for c in COURSES]
    if fn == "mod_forum_get_forum_discussions":
        cid = p["forumid"] - 100
        return {"discussions": [{"discussion": did, "subject": s, "message": b, "created": cr, "modified": cr,
                                 "userfullname": "Instructor", "numreplies": 0} for did, s, b, cr in POSTS.get(cid, [])]}
    if fn == "mod_quiz_get_quizzes_by_courses":
        return {"quizzes": [{"id": 7, "course": 3, "name": "Quiz 2", "timeopen": int((today + timedelta(days=1)).replace(hour=10, minute=0).timestamp()), "timeclose": 0, "intro": ""}]}
    return {}


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="moodle-brief-demo-"))
    mb.DATA_DIR, mb.STATE_FILE, mb.BACKUP_FILE = tmp, tmp / "state.json", tmp / "state.bak.json"
    mb.LOG_FILE, mb.ARCHIVE_FILE = tmp / "log.txt", tmp / "archive.jsonl"
    mb.MOODLE_TOKEN, mb.TG_TOKEN, mb.TG_CHAT = "demo", "demo", "demo"
    mb.Moodle.call = fake_call
    mb.log = lambda msg: None
    captured = []
    mb.tg_send = lambda text, parse_mode=None: captured.append(text)
    sys.argv = ["moodle_brief.py", "run", "--force"]
    mb.main()
    import html
    import re
    text = html.unescape(re.sub(r"</?[bi]>|<a [^>]*>|</a>", "", captured[0]))
    print(text)


if __name__ == "__main__":
    main()
