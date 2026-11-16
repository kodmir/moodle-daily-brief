"""v1.7: exam location, class average, evening reminder, and a reader that survives malformed records."""
import json

import pytest

from conftest import DAY, FROZEN, FROZEN_TS, FrozenDatetime, ts
from test_scenarios import FakeMoodle, FakeTelegram, env, new_day, plain, run  # noqa: F401
from test_v16 import ctx_of, doc_ev, exact_ev, wrap

NOW = FROZEN_TS   # Thursday 5 Nov 2026, 10:00 Istanbul


def at(mb, monkeypatch, hour, minute=0, day=5):
    """Move the frozen clock (same day by default)."""
    t = FROZEN.replace(day=day, hour=hour, minute=minute)

    class Clock(FrozenDatetime):
        @classmethod
        def now(cls, tz=None):
            return t.astimezone(tz) if tz else t.replace(tzinfo=None)
    monkeypatch.setattr(mb, "datetime", Clock)
    monkeypatch.setattr(mb.time, "time", lambda: int(t.timestamp()))


# ------------------------------------------------------------------ where the exam is

@pytest.mark.parametrize("text, place", [
    ("The exam will be held on November 17, from 17:00 to 19:00 , in M100 and M1170 .", "M100, M1170"),
    ("Quiz 2 will be held on November 9 in room NH 304.", "NH304"),
    ("The objection session is on November 9 at the BUFAIM Lab (M2142).", "M2142"),
    ("Midterm: November 17 at 17:00.\nRooms: M1100, M1170, M2171 or M2180", "M1100, M1170, M2171, M2180"),
    ("Vize 17 Kasım Salı 17:00. Yer: KB301 ve KB302", "KB301, KB302"),
    ("PS6: Tuesday, November 10th, 17-19, at İB102", "İB102"),
    ("Check your assigned classroom (M 1170, M 2171 or M 2180) before the exam on November 17.", "M1170, M2171, M2180"),
    # not places
    ("The IE202 midterm is on November 17 in IE202.", None),              # the course's own code
    ("We will meet at NOV 17 for the quiz.", None),
    ("In 2026 the final exam is on December 20.", None),
    ("Homework is due November 9. Submit it in HW12 format.", None),
    ("The midterm on November 17 covers everything in chapters 1-7.", None),
    ("Students enrolled in Math101.01 take the midterm on November 17.", None),
])
def test_exam_place(mb, text, place):
    evs = mb.regex_dates(text, NOW, "", "IE202")
    assert evs, text
    assert evs[0].get("place") == place


def test_room_is_shown_with_the_exam(env):
    mb, moodle, tg = env
    moodle.posts = [(101, 1, "Midterm Date Updated",
                     "The exam will be held on November 17, from 17:00 to 19:00 , in M100 and M1170 .", NOW - DAY)]
    run(mb, "run")
    msg = plain(tg.last)
    assert "IE202 Ara sınav ❔ · 17 Kas Sal 17:00 · M100, M1170 (12 gün)" in msg       # exams
    assert "→ Ara sınav 17 Kas Sal 17:00 · M100, M1170" in msg                          # the announcement's own line


def test_room_from_the_announcement_is_carried_to_moodles_own_record(mb):
    """The quiz module knows the time, only the announcement knows the room."""
    exact = [mb.struct_ev("IE202", "Quiz 2", "quiz kapanış", ts(2026, 11, 9, 13, 0), "moodle quiz")]
    docs = [{**doc_ev("IE202", "quiz", "2026-11-09", "Quiz 2 will be held in M1100", time="12:00"), "place": "M1100"}]
    evs = mb.merged_events(ctx_of(mb, exact, docs))
    assert len(evs) == 1 and evs[0]["certainty"] == "exact" and evs[0]["place"] == "M1100"


def test_todays_exam_is_not_listed_twice(env):
    mb, moodle, tg = env
    moodle.posts = [(101, 1, "Midterm", "The midterm is on November 5 at 17:00 in M100.", NOW - 3 * DAY),
                    (102, 1, "Final", "The final exam is on December 10 at 09:00.", NOW - 3 * DAY)]
    run(mb, "run")
    msg = plain(tg.last)
    assert "BUGÜN\n• 17:00 IE202 Ara sınav — The midterm is on November 5 at 17:00 in M100 ❔\n" in msg   # room once
    exams = msg.split("SINAVLAR")[1].split("\n\n")[0]
    assert "Final" in exams and "Ara sınav" not in exams


# ------------------------------------------------------------------ grades

def test_class_average_and_rank_when_moodle_gives_them(env):
    mb, moodle, tg = env
    moodle.grades = {1: [{"id": 1, "itemname": "Midterm", "itemtype": "mod", "graderaw": 28, "gradeformatted": "28.00",
                          "grademax": 40, "gradedategraded": NOW - 3600, "averageformatted": "21.46", "rank": 12,
                          "numusers": 85},
                         {"id": 2, "itemname": "Quiz 1", "itemtype": "mod", "graderaw": 7, "gradeformatted": "7.00",
                          "grademax": 10, "gradedategraded": NOW - 3600, "averageformatted": "-"}]}
    run(mb, "run")
    msg = plain(tg.last)
    assert "IE202 Midterm: 28/40 · ort. 21.5 · sıra 12/85" in msg
    assert "IE202 Quiz 1: 7/10\n" in msg + "\n"
    assert "<b>28/40</b> · ort. 21.5" in tg.last                     # only the grade itself is bold
    # the average moving later is not a new grade
    moodle.grades[1][0]["averageformatted"] = "22.90"
    new_day(mb)
    run(mb, "run", "--force")
    assert "NOTLAR" not in tg.last


def test_grade_formatting_edge_cases(mb):
    assert mb.fmt_grade({"gradeformatted": "31.00", "grademax": "100.00"}) == "31/100"     # max as text
    assert mb.fmt_grade({"gradeformatted": "12.345", "grademax": 20}) == "12.35/20"
    assert mb.fmt_grade({"gradeformatted": "AA", "grademax": 100}) == "AA"
    assert mb.fmt_grade({"gradeformatted": "7,5", "grademax": 10}) == "7.5/10"
    assert mb.grade_stats({"averageformatted": "61.20 (85)", "rank": 90, "numusers": 85}) == "ort. 61.2"
    assert mb.grade_stats({"averageformatted": None, "rank": "x"}) == ""


# ------------------------------------------------------------------ noise

def test_content_change_notification_is_dropped(env, monkeypatch):
    """'<course> content change' says only that something changed; the brief itself says what."""
    mb, moodle, tg = env
    run(mb, "run")

    def answer(fn, p):
        if fn == "message_popup_get_popup_notifications":
            return {"notifications": [
                {"id": 9, "subject": "2026/2027-1 IE  202.01 OPERATIONS RESEARCH I content change",
                 "smallmessage": "Grades has been changed", "timecreated": NOW - 3600},
                {"id": 10, "subject": "Your booking was confirmed", "smallmessage": "Slot 3", "timecreated": NOW - 3600}]}
    wrap(mb, monkeypatch, moodle, answer)
    new_day(mb)
    run(mb, "run", "--force")
    assert "content change" not in tg.last and "OPERATIONS" not in tg.last
    assert "Your booking was confirmed" in tg.last


def test_course_code_is_found_anywhere_in_the_name(mb):
    sc = lambda s: mb.short_course({"shortname": s})
    assert sc("2026/2027-1 IE  306.01") == "IE306" and sc("MATH101.05") == "MATH101"
    assert sc("Fall 2026 IE 202 Section 1") == "IE202"               # was "FALL202"
    assert sc("PHYS101L.03") == "PHYS101L" and sc("Turkish for Foreigners") == "Turkish for Foreigners"
    assert len(sc("x" * 500)) <= 24


# ------------------------------------------------------------------ evening reminder

def setup_evening(mb, moodle, tg, monkeypatch):
    """Morning brief sent; an exam tomorrow, one assignment due tonight, one submitted for tomorrow."""
    moodle.posts = [(101, 1, "Midterm", "The midterm is on November 6 at 17:00 in M100 and M1170.", NOW - 3 * DAY)]
    moodle.assignments = [(55, "Homework 5", ts(2026, 11, 5, 23, 59)), (56, "Homework 6", ts(2026, 11, 6, 23, 59))]
    wrap(mb, monkeypatch, moodle, lambda fn, p: (
        {"lastattempt": {"submission": {"status": "submitted" if p["assignid"] == 56 else "new"}}}
        if fn == "mod_assign_get_submission_status" else None))
    assert run(mb, "run", "--scheduled") == 0 and len(tg.sent) == 1
    tg.sent.clear()


def test_evening_reminder(env, monkeypatch):
    mb, moodle, tg = env
    setup_evening(mb, moodle, tg, monkeypatch)
    at(mb, monkeypatch, 19, 30)
    run(mb, "run", "--scheduled")
    assert tg.sent == []                                             # not yet 20:00
    at(mb, monkeypatch, 20, 7)
    assert run(mb, "run", "--scheduled") == 0
    assert plain(tg.last).strip() == ("🌙 Yarın · 6 Kas Cuma\n"
                              "• 17:00 IE202 Ara sınav ❔ · M100, M1170\n\n"
                              "⏳ Bu gece\n"
                              "• 23:59 IE202 Homework 5\n\n"
                              "❔ = duyuru metninden çıkarıldı, teyit et")
    assert "Homework 6" not in tg.last                               # submitted: nothing to remind
    at(mb, monkeypatch, 21, 7)
    run(mb, "run", "--scheduled")
    assert len(tg.sent) == 1                                         # once per evening


def test_evening_with_nothing_ahead_stays_silent(env, monkeypatch):
    mb, moodle, tg = env
    moodle.posts = [(101, 1, "Slides", "Slides are uploaded.", NOW - DAY)]
    run(mb, "run", "--scheduled")
    tg.sent.clear()
    at(mb, monkeypatch, 20, 7)
    assert run(mb, "run", "--scheduled") == 0 and tg.sent == []
    assert "hatırlatılacak bir şey yok" in mb.LOG_FILE.read_text()


def test_reminder_does_not_swallow_tomorrows_news(env, monkeypatch):
    """An announcement posted in the afternoon shows up in the reminder as an event and is still NEW next morning."""
    mb, moodle, tg = env
    run(mb, "run", "--scheduled")
    tg.sent.clear()
    moodle.posts.append((102, 1, "Quiz 3", "Quiz 3 will be held tomorrow at 12:00 in M1100.", NOW + 5 * 3600))
    at(mb, monkeypatch, 20, 7)
    run(mb, "run", "--scheduled")
    assert "12:00 <b>IE202</b> Quiz ❔ · M1100" in tg.last
    seen = json.loads(mb.STATE_FILE.read_text())["seen"]
    assert "disc:102" not in seen
    at(mb, monkeypatch, 7, 30, day=6)
    run(mb, "run", "--scheduled")
    assert "DUYURULAR" in tg.last and "Quiz 3" in tg.last and "BUGÜN" in tg.last


def test_reminder_is_not_a_run_for_the_hide_rule(env, monkeypatch):
    mb, moodle, tg = env
    run(mb, "run", "--scheduled")
    moodle.posts.clear()                                             # the announcement disappears from Moodle
    at(mb, monkeypatch, 20, 7)
    run(mb, "run", "--scheduled")
    st = json.loads(mb.STATE_FILE.read_text())
    assert st["last_reminder_date"] == "2026-11-05"
    assert st["missing"] == {} and not st["extracted"]["disc:101"].get("hidden")


def test_reminder_can_be_switched_off_and_run_by_hand(env, monkeypatch, capsys):
    mb, moodle, tg = env
    setup_evening(mb, moodle, tg, monkeypatch)
    monkeypatch.setattr(mb, "REMINDER_TIME", "off")
    at(mb, monkeypatch, 22, 0)
    run(mb, "run", "--scheduled")
    assert tg.sent == []
    assert run(mb, "remind") == 0 and "Yarın" in tg.last             # asked for explicitly: any time, any setting
    assert run(mb, "remind") == 0 and len(tg.sent) == 2              # ...and as often as asked


def test_reminder_failure_is_quiet(env, monkeypatch):
    """Moodle down in the evening: no error message, the morning brief will come anyway."""
    mb, moodle, tg = env
    setup_evening(mb, moodle, tg, monkeypatch)
    at(mb, monkeypatch, 20, 7)
    moodle.mode = "net"
    monkeypatch.setattr(mb.Moodle, "call", lambda _s, fn, **p: moodle(fn, **p))
    assert run(mb, "run", "--scheduled") == 0 and tg.sent == []
    moodle.mode = "ok"
    at(mb, monkeypatch, 21, 7)
    run(mb, "run", "--scheduled")
    assert len(tg.sent) == 1 and "Yarın" in tg.last                  # the later slot retries


# ------------------------------------------------------------------ a malformed record costs one record, not the brief

def test_one_broken_record_does_not_stop_the_brief(env, monkeypatch):
    mb, moodle, tg = env
    run(mb, "run")
    moodle.posts.append((102, 1, "Quiz 3", "Quiz 3 is on November 9 at 12:00.", NOW - 3600))

    def broken(fn, p):
        if fn == "core_course_get_contents":
            return [{"id": 1, "summary": "", "modules": [
                {"id": 1, "modname": "assign", "name": "Homework", "dates": "soon", "contents": 7, "description": ["x"]},
                "not a module", None,
                {"id": 2, "modname": "resource", "name": {"bad": 1}, "contents": [{"type": "file", "filename": 5,
                                                                                    "timemodified": "yesterday"}]},
                {"id": 3, "modname": "quiz", "name": "Quiz 3", "dates": [{"label": None, "timestamp": "1e400"},
                                                                          {"label": 4, "timestamp": NOW + DAY}]}]}]
        if fn == "core_calendar_get_calendar_events":
            return {"events": [{"id": 1, "name": "Meeting", "courseid": {"x": 1}, "timestart": NOW + DAY},
                               {"id": 2, "name": None, "timestart": "soon"}, 17]}
        if fn == "mod_assign_get_assignments":
            return {"courses": [{"id": 1, "assignments": [{"id": 5, "name": "HW", "duedate": "tomorrow", "intro": 3}]},
                                "x"]}
    wrap(mb, monkeypatch, moodle, broken)
    new_day(mb)
    assert run(mb, "run", "--force") == 0
    assert "Quiz 3" in tg.last and "çalışmadı" not in tg.last
    log = mb.LOG_FILE.read_text()
    assert "biçimi beklenmeyen bir takvim kaydı atlandı" in log
    # nothing is treated as removed in a run where something could not be read
    for _ in range(3):
        new_day(mb)
        run(mb, "run", "--force")
    st = json.loads(mb.STATE_FILE.read_text())
    assert st["missing"] == {} and "kaldırıldı" not in tg.last


def test_moodle_without_identity_is_retried_later(env, monkeypatch):
    mb, moodle, tg = env
    wrap(mb, monkeypatch, moodle, lambda fn, p: [] if fn == "core_webservice_get_site_info" else None)
    assert run(mb, "run", "--scheduled") == 0 and tg.sent == []
    assert "Geçici hata" in mb.LOG_FILE.read_text()


def test_overlong_line_is_split_without_breaking_the_markup(env):
    mb, moodle, tg = env
    moodle.posts = [(101, 1, "A & B " + "x" * 9000, "Midterm on November 17 at 17:00.", NOW - DAY)]
    moodle.courses[0]["shortname"] = "y" * 600
    run(mb, "run")
    assert all(len(s["text"]) <= 4096 for s in tg.sent)
    line = "• <b>IE202</b> <b>bold</b> <i>it</i> &amp; " + "z" * 5000 + "&amp;" * 300
    tg.sent.clear()
    mb.tg_send(line, parse_mode="HTML")
    assert len(tg.sent) >= 2
    for s in tg.sent:
        t = s["text"]
        assert "<" not in t and ">" not in t                         # markup dropped for that line, text kept
        assert not __import__("re").search(r"&(?!amp;)", t)          # no entity cut in half
    assert "".join(s["text"] for s in tg.sent).count("&amp;") == 301


# ------------------------------------------------------------------ v1.7.1: found in the first evening of real use

REMINDER_POST = ("Dear all,\n This is a reminder that the IE202 Midterm will be held on November 17 (tomorrow), from 17:00 to "
                 "19:00 , in M1100 and M1170 .\n\n The classroom assignments are as follows, based on your surname:\n"
                 " AÇ – İNCEBOY: M1100\n İPEK – ZELKA: M1170\n\n Please arrive 10 minutes before the exam begins .\n Best,\nTA")


def test_superseded_date_in_a_remark_is_not_a_second_exam(mb):
    """Real post: the old date is only mentioned to explain the change."""
    text = ("The third exam of the semester will be held on 2nd of December, Wednesday from 17:00 to 19:00 (Last week I "
            "mentioned 1st of December as the possible exam date, but had difficulty in finding exam rooms, so we shifted "
            "1 day)\n There will be no lecture on the exam day")
    assert [(e["type"], e["date"], e["time"]) for e in mb.regex_dates(text, NOW, "Exam No 3", "IE306")] == \
        [("exam", "2026-12-02", "17:00")]
    tr = "Final sınavı 12 Ocak Salı 10:00'da yapılacaktır, daha önce 11 Ocak demiştim."
    assert [e["date"] for e in mb.regex_dates(tr, NOW, "", "IE306")] == ["2027-01-12"]
    # a plain second date is still read
    assert len(mb.regex_dates("Quiz 1 is on November 9. Quiz 2 is on November 23.", NOW, "", "IE306")) == 2


def test_reminder_post_does_not_revive_an_old_date_change_warning(mb):
    """The date moved weeks ago. A reminder repeating the (new) date is not a fresh change."""
    evs = mb.supersede([
        {"course": "IE202", "type": "midterm", "title": "midterm", "date": "2026-11-01", "posted": NOW - 40 * DAY},
        {"course": "IE202", "type": "midterm", "title": "midterm", "date": "2026-11-17", "posted": NOW - 30 * DAY},
        {"course": "IE202", "type": "midterm", "title": "midterm", "date": "2026-11-17", "posted": NOW - DAY}])
    assert [e["date"] for e in evs] == ["2026-11-17"] and "changed_from" not in evs[0]
    recent = mb.supersede([
        {"course": "IE202", "type": "midterm", "title": "midterm", "date": "2026-11-01", "posted": NOW - 40 * DAY},
        {"course": "IE202", "type": "midterm", "title": "midterm", "date": "2026-11-17", "posted": NOW - 2 * DAY}])
    assert recent[0]["changed_from"] == "2026-11-01"


def test_seat_ranges_are_read_in_turkish_alphabetical_order(mb):
    seats = mb.find_seats(REMINDER_POST)
    assert seats == [["AÇ", "İNCEBOY", "M1100"], ["İPEK", "ZELKA", "M1170"]]
    room = lambda name: (mb.seat_for(name, seats) or [None, None, None])[2]
    assert room("Özbey") == "M1170"            # Ö sorts between O and P, not after Z
    assert room("Çelik") == "M1100" and room("Ilgaz") == "M1100" and room("İnce") == "M1100"
    assert room("İpekçi") == "M1170" and room("şahin") == "M1170" and room("Zelkan") == "M1170"
    assert room("Abak") is None and room("Zorlu") is None and room("") is None      # outside every range: no guess
    assert mb.find_seats("M100: Abak - Çelik\nM1170: Demir - Öz\nM2171: Öztürk - Zorlu") == \
        [["Abak", "Çelik", "M100"], ["Demir", "Öz", "M1170"], ["Öztürk", "Zorlu", "M2171"]]
    # not seat lists
    assert mb.find_seats("Monday - Friday: NH101\nA - C: NH102") == []              # not ascending
    assert mb.find_seats("A – K: NH101") == []                                      # a single line proves nothing
    assert mb.find_seats("A - M: NH101\nK - Z: NH102") == []                        # overlapping
    assert mb.seat_for("Özbey", [["A", "Z", "M1"], ["B", "Y", "M2"]]) is None       # two matches: no guess


def test_own_room_is_shown_when_rooms_are_split_by_surname(env, monkeypatch):
    mb, moodle, tg = env
    moodle.posts = [(101, 1, "Midterm Exam", REMINDER_POST.replace("November 17 (tomorrow)", "November 6 (tomorrow)"),
                     NOW - 3600)]
    wrap(mb, monkeypatch, moodle, lambda fn, p: (
        {"userid": 7, "firstname": "Emir Eymen", "lastname": "Özbey", "fullname": "Emir Eymen Özbey"}
        if fn == "core_webservice_get_site_info" else None))
    run(mb, "run", "--scheduled")
    assert "IE202 Ara sınav ❔ · 6 Kas Cum 17:00 · M1170 (soyadına göre: İPEK–ZELKA) (yarın)" in plain(tg.last)
    at(mb, monkeypatch, 20, 7)
    run(mb, "run", "--scheduled")
    assert plain(tg.last).startswith("🌙 Yarın · 6 Kas Cuma\n• 17:00 IE202 Ara sınav ❔ · M1170 (soyadına göre: İPEK–ZELKA)")
    # the surname is used in memory only
    assert "Özbey" not in mb.STATE_FILE.read_text() and "Özbey" not in mb.ARCHIVE_FILE.read_text()


def test_surname_outside_the_listed_ranges_gets_all_rooms(env, monkeypatch):
    mb, moodle, tg = env
    moodle.posts = [(101, 1, "Midterm Exam", REMINDER_POST.replace("November 17 (tomorrow)", "November 6 (tomorrow)"),
                     NOW - 3600)]
    wrap(mb, monkeypatch, moodle, lambda fn, p: (
        {"userid": 7, "fullname": "Ali Abak"} if fn == "core_webservice_get_site_info" else None))
    run(mb, "run")
    assert "17:00 · M1100, M1170 (yarın)" in plain(tg.last) and "soyadına" not in tg.last
