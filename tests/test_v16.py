"""v1.6: fixes found by replaying a real semester's archive through the brief.

Each test is a case that was wrong before: a false "updated", a false exam, a date that was silently
merged away, an old announcement mistaken for a removed one.
"""
import json

import pytest

from conftest import DAY, FROZEN_TS, ts
from test_scenarios import FakeMoodle, FakeTelegram, env, new_day, other_lines, plain, run  # noqa: F401

NOW = FROZEN_TS   # Thursday 5 Nov 2026, 10:00 Istanbul


def wrap(mb, monkeypatch, moodle, extra):
    """Let a test answer some web-service functions itself and leave the rest to FakeMoodle."""
    def call(_self, fn, **p):
        out = extra(fn, p)
        return moodle(fn, **p) if out is None else out
    monkeypatch.setattr(mb.Moodle, "call", call)


# ------------------------------------------------------------------ what counts as "updated"

def test_deadline_passing_is_not_an_update(env):
    """Moodle relabels 'Closes:' to 'Closed:' once the time passes. The content did not change."""
    mb, moodle, tg = env
    survey = {"id": 720, "modname": "feedback", "name": "Self-study Material 2 Responses",
              "dates": [{"label": "Closes:", "timestamp": NOW + 3600}]}
    moodle.modules = [survey]
    run(mb, "run")
    survey["dates"] = [{"label": "Closed:", "timestamp": NOW + 3600}]
    new_day(mb)
    run(mb, "run", "--force")
    assert "Self-study Material 2" not in tg.last.split("🆕")[-1] or "🆕" not in tg.last
    assert "✏️" not in tg.last and "Closed" not in tg.last
    # ...and it stays quiet on the following day too (the relabelled version is now the seen one)
    new_day(mb)
    run(mb, "run", "--force")
    assert "✏️" not in tg.last


def test_moved_deadline_is_still_an_update(env):
    mb, moodle, tg = env
    survey = {"id": 720, "modname": "feedback", "name": "Self-study Material 2 Responses",
              "dates": [{"label": "Closes:", "timestamp": NOW + 2 * DAY}]}
    moodle.modules = [survey]
    run(mb, "run")
    survey["dates"] = [{"label": "Closes:", "timestamp": NOW + 4 * DAY}]
    new_day(mb)
    run(mb, "run", "--force")
    line = [l for l in other_lines(tg.last) if "Self-study" in l][0]
    assert "✏️" in line and "2026-11-09" in line          # the new closing date is what changed


def test_reply_does_not_mark_the_announcement_as_updated(env, monkeypatch):
    """A reply bumps the discussion's 'modified' time. The reply is news; the unchanged announcement is not."""
    mb, moodle, tg = env
    moodle.posts = [(101, 1, "Midterm", "The IE202 midterm will be held on November 17 at 17:00.", NOW - 2 * DAY)]
    run(mb, "run")

    def bumped(fn, p):
        if fn == "mod_forum_get_forum_discussions" and p["forumid"] == 51:
            return {"discussions": [{"discussion": 101, "id": 1010, "subject": "Midterm",
                                     "message": "The IE202 midterm will be held on November 17 at 17:00.",
                                     "created": NOW - 2 * DAY, "modified": NOW - 60, "userfullname": "Instructor",
                                     "numreplies": 1}]}
    moodle.replies[101] = [(5001, "Rooms: M100 and M1170.", NOW - 60)]
    wrap(mb, monkeypatch, moodle, bumped)
    new_day(mb)
    run(mb, "run", "--force")
    msg = plain(tg.last)
    assert "güncellendi" not in msg
    assert "Re: Midterm" in msg and msg.count("· Midterm") == 0


def test_change_summary_survives_a_failed_send(env, monkeypatch):
    """Telegram is down on the first attempt. The retry must still say WHAT changed, not a bare 'updated'."""
    mb, moodle, tg = env
    run(mb, "run")
    moodle.posts[0] = (101, 1, "Midterm", "The IE202 midterm will be held on November 17 at 17:00.\nRoom: M1100.",
                       NOW - 5 * DAY)
    new_day(mb)

    def down(url, json=None, timeout=None):
        raise mb.requests.ConnectionError("telegram down")
    monkeypatch.setattr(mb.requests, "post", down)
    assert run(mb, "run", "--force") != 0
    monkeypatch.setattr(mb.requests, "post", tg)
    assert run(mb, "run", "--force") == 0
    assert "güncellendi" in tg.last and "Room: M1100" in tg.last


def test_test_command_does_not_eat_the_change_summary(env, capsys):
    mb, moodle, tg = env
    run(mb, "run")
    moodle.posts[0] = (101, 1, "Midterm", "The IE202 midterm will be held on November 17 at 17:00.\nRoom: M1100.",
                       NOW - 5 * DAY)
    new_day(mb)
    run(mb, "test")                                        # looks, sends nothing, marks nothing as seen
    assert "Room: M1100" in capsys.readouterr().out
    run(mb, "run")
    assert "Room: M1100" in tg.last


# ------------------------------------------------------------------ reading dates out of text

@pytest.mark.parametrize("text, expected", [
    ("Quiz 2 may be postponed, we will let you know.", []),                       # not the 2nd of May
    ("Students in section 3 may take the quiz in room M1100.", []),
    ("The final exam is on 12 May at 10:00.", [("final", "2027-05-12", "10:00")]),  # a real May date still works
    ("Ödev 3 Mayıs tarihine kadar teslim edilmelidir.", [("assignment", "2027-05-03", None)]),
    ("Finally, please note that on November 24 there is no class.", [("other", "2026-11-24", None)]),
    ("We will examine the reports on November 25.", [("other", "2026-11-25", None)]),
    ("For example, the quiz on November 20 covers chapter 5.", [("quiz", "2026-11-20", None)]),
    ("There will be no class on November 26 due to the holiday.", [("other", "2026-11-26", None)]),
    ("The report is due November 26.", [("assignment", "2026-11-26", None)]),
    ("The quiz will start at 9.12 in M1100.", []),                                # a time, not 9 December
    ("Quiz 3 is on 9.12 in M1100.", [("quiz", "2026-12-09", None)]),              # "on" still reads as a date
    ("The final examination is on November 30 at 09:00.", [("final", "2026-11-30", "09:00")]),
])
def test_date_traps(mb, text, expected):
    got = [(e["type"], e["date"], e["time"]) for e in mb.regex_dates(text, NOW, "")]
    assert got == expected


def test_deadlines_named_after_an_exam_are_not_exams(mb):
    assert not mb.is_exam({"type": "assign", "title": "Midterm Project Report"})
    assert not mb.is_exam({"type": "ödev teslimi", "title": "Final Project Submission"})
    assert not mb.is_exam({"type": "feedback", "title": "Example Sheet 3 (kapanış)"})
    assert not mb.is_exam({"type": "course", "title": "Finally: group lists"})
    assert mb.is_exam({"type": "course", "title": "Midterm"})                    # a teacher's calendar entry
    assert mb.is_exam({"type": "quiz kapanış", "title": "Quiz 3 (kapanış)"})
    assert mb.is_exam({"type": "class_change", "title": "The midterm is postponed to November 20"})


def test_weekly_unnumbered_quiz_is_not_a_date_change(mb):
    """'Quiz on Monday' is announced again every week. Last week's date had passed: nothing was rescheduled."""
    def evs(typ, title, old_date, old_posted, new_date, new_posted):
        return mb.supersede([
            {"course": "IE202", "type": typ, "title": title, "date": old_date, "posted": old_posted},
            {"course": "IE202", "type": typ, "title": title, "date": new_date, "posted": new_posted}])
    weekly = evs("quiz", "quiz on monday", "2026-11-02", ts(2026, 10, 29), "2026-11-09", ts(2026, 11, 4))
    assert [e["date"] for e in weekly] == ["2026-11-09"] and "changed_from" not in weekly[0]
    # the same quiz moved while its old date was still ahead: that IS a change
    moved = evs("quiz", "quiz on monday", "2026-11-09", ts(2026, 11, 2), "2026-11-12", ts(2026, 11, 4))
    assert moved[0].get("changed_from") == "2026-11-09"
    # numbered and named exams keep the old behaviour, even when announced after the old date
    late = evs("midterm", "midterm", "2026-11-01", NOW - 60 * DAY, "2026-11-17", NOW - 2 * DAY)
    assert late[0].get("changed_from") == "2026-11-01"


# ------------------------------------------------------------------ merging text dates with Moodle's own records

def ctx_of(mb, exact, docs):
    return {"moodle_calendar_and_deadlines": exact, "dates_found_in_documents": docs}


def exact_ev(mb, course, title, typ, y, mo, d, h=23, mi=59, source="moodle ödev"):
    return mb.struct_ev(course, title, typ, ts(y, mo, d, h, mi), source)


def doc_ev(course, typ, date, title, item="disc:1", source="Announcement", time=None):
    return {"course": course, "type": typ, "date": date, "time": time, "title": title, "certainty": "approximate",
            "item": item, "source": source, "posted": NOW - DAY}


def test_review_session_on_a_deadline_day_is_not_swallowed(mb):
    """Before: any two non-exam events of one course on one day were 'the same thing'."""
    evs = mb.merged_events(ctx_of(mb,
        [exact_ev(mb, "IE202", "Homework 5", "ödev teslimi", 2026, 11, 9)],
        [doc_ev("IE202", "review", "2026-11-09", "The objection session for Quiz 2 will be held on Monday", time="15:00"),
         doc_ev("IE202", "assignment", "2026-11-09", "Homework 5 is due on Monday", item="disc:2")]))
    assert [(e["type"], e["_t"]) for e in evs] == [("review", "15:00"), ("ödev teslimi", "23:59")]


def test_two_posts_about_one_session_are_listed_once(mb):
    evs = mb.merged_events(ctx_of(mb, [], [
        doc_ev("IE202", "review", "2026-11-09", "The objection session will be held on Monday", time="15:00"),
        doc_ev("IE202", "review", "2026-11-09", "Reminder: objection session on November 9", item="disc:2")]))
    assert len(evs) == 1


def test_description_date_conflicting_with_the_moodle_deadline(mb):
    """Real case: the assignment closes on the 9th in Moodle, its own description says the 8th.
    Before: two unrelated-looking lines. Now: one line with a warning."""
    title = "2nd Exercise MakeUp due November 9, by 23.59"
    exact = [exact_ev(mb, "AD216", title, "ödev teslimi", 2026, 11, 9)]
    docs = [doc_ev("AD216", "assignment", "2026-11-08", "The assignment is due November 8 by 23.59",
                   item=k, source=s, time="23:59")
            for k, s in (("assign:66858", title), ("mod:1134416", title), ("cal:29214936", title + " is due"))]
    evs = mb.merged_events(ctx_of(mb, exact, docs))
    assert len(evs) == 1 and evs[0]["text_dates"] == ["2026-11-08"]
    brief = plain(mb.free_brief({**ctx_of(mb, exact, docs), "today": ""}, []))
    assert brief.count("AD216") == 1
    assert "açıklamasında 8 Kas yazıyor, Moodle'da 9 Kas" in brief


def test_description_date_equal_to_the_deadline_is_just_a_duplicate(mb):
    # Moodle stores "end of the 9th" as the 10th at 00:00; the description says "November 9 by 23.59"
    exact = [exact_ev(mb, "AD216", "Homework 5", "ödev teslimi", 2026, 11, 10, 0, 0)]
    docs = [doc_ev("AD216", "assignment", "2026-11-09", "Due November 9 by 23.59", item="assign:5", source="Homework 5")]
    evs = mb.merged_events(ctx_of(mb, exact, docs))
    assert len(evs) == 1 and "text_dates" not in evs[0]


def test_far_apart_description_date_is_a_separate_milestone(mb):
    """'Draft due Nov 7' inside an assignment that closes on the 25th is a real, separate date."""
    exact = [exact_ev(mb, "AD216", "Term Project", "ödev teslimi", 2026, 11, 25)]
    docs = [doc_ev("AD216", "assignment", "2026-11-07", "The draft is due November 7", item="assign:9", source="Term Project")]
    evs = mb.merged_events(ctx_of(mb, exact, docs))
    assert [e["date"] for e in evs] == ["2026-11-07", "2026-11-25"] and "text_dates" not in evs[1]


def test_date_in_a_notification_does_not_repeat_the_course_event(mb):
    """A notification about a forum post carries the post's title; its date is the same event again."""
    docs = [doc_ev("IE202", "midterm", "2026-11-17", "The exam will be held on November 17", time="17:00"),
            doc_ev("Bildirim", "midterm", "2026-11-17", "posted in IE 202.01: Midterm on November 17", item="notif:7")]
    assert [e["course"] for e in mb.merged_events(ctx_of(mb, [], docs))] == ["IE202"]
    alone = [doc_ev("Bildirim", "midterm", "2026-11-17", "Midterm on November 17", item="notif:7")]
    assert len(mb.merged_events(ctx_of(mb, [], alone))) == 1        # nothing else knows it: keep it


def test_submitted_assignment_is_marked_done(env, monkeypatch):
    mb, moodle, tg = env
    moodle.assignments = [(55, "Homework 5", NOW + 2 * DAY), (56, "Homework 6", NOW + 3 * DAY)]
    asked = []

    def status(fn, p):
        if fn == "mod_assign_get_submission_status":
            asked.append(p["assignid"])
            return {"lastattempt": {"submission": {"status": "submitted" if p["assignid"] == 55 else "new"}}}
    wrap(mb, monkeypatch, moodle, status)
    run(mb, "run")
    msg = plain(tg.last)
    assert "Homework 5 ✓ teslim edildi" in msg
    assert "Homework 6" in msg and "Homework 6 ✓" not in msg
    assert sorted(asked) == [55, 56]


def test_submission_status_unavailable_is_harmless(env, monkeypatch):
    mb, moodle, tg = env
    moodle.assignments = [(55, "Homework 5", NOW + 2 * DAY)]

    def status(fn, p):
        if fn == "mod_assign_get_submission_status":
            raise mb.MoodleError("mod_assign_get_submission_status: nopermission")
    wrap(mb, monkeypatch, moodle, status)
    assert run(mb, "run") == 0
    assert "Homework 5" in tg.last and "✓" not in tg.last


def test_activity_dates_do_not_depend_on_the_moodle_language(env):
    """With Moodle set to Turkish the labels are not 'Opens:'/'Due:'. The language-independent id is used."""
    mb, moodle, tg = env
    moodle.modules = [
        {"id": 730, "modname": "assign", "name": "Ödev 3", "dates": [
            {"label": "Açıldı:", "timestamp": NOW + DAY, "dataid": "allowsubmissionsfromdate"},
            {"label": "Son teslim tarihi:", "timestamp": NOW + 2 * DAY, "dataid": "duedate"}]},
        {"id": 731, "modname": "feedback", "name": "Anket", "dates": [
            {"label": "Kapanıyor:", "timestamp": NOW + 3 * DAY, "dataid": "timeclose"}]},
    ]
    run(mb, "run")
    week = plain(tg.last).split("📅")[1].split("\n\n")[0]
    assert "IE202 Ödev 3\n" in week + "\n" and "Ödev 3 (" not in week        # the due date, shown plainly
    assert "Açıldı" not in week and "açıldı" not in week                      # an assignment opening is noise
    assert "Anket (kapanış)" in week


# ------------------------------------------------------------------ nothing is "removed" just because it scrolled away

def paged_forum(n, removed=()):
    """A news forum with n discussions, served 40 per page like Moodle does."""
    def answer(fn, p):
        if fn == "mod_forum_get_forum_discussions" and p["forumid"] == 51:
            ids = [i for i in range(n, 0, -1) if i not in removed]            # newest first
            page = ids[p["page"] * p["perpage"]:(p["page"] + 1) * p["perpage"]]
            return {"discussions": [
                {"discussion": 1000 + i, "id": 10000 + i, "subject": f"Announcement {i}",
                 "message": "The final exam is on January 5 at 10:00." if i == 1 else f"Note {i}.",
                 "created": NOW - (n - i + 1) * 3600, "modified": NOW - (n - i + 1) * 3600,
                 "userfullname": "Instructor", "numreplies": 0} for i in page]}
    return answer


def test_announcement_beyond_the_first_page_is_still_read(env, monkeypatch):
    """Before: only the newest 40 discussions were read, so the 41st-newest (here: the one with the final
    exam date) went 'missing', was hidden after three runs and reported as removed from Moodle."""
    mb, moodle, tg = env
    wrap(mb, monkeypatch, moodle, paged_forum(45))
    for _ in range(4):
        new_day(mb) if mb.STATE_FILE.exists() else None
        assert run(mb, "run", "--force") == 0
    st = json.loads(mb.STATE_FILE.read_text())
    assert sum(k.startswith("disc:10") for k in st["extracted"]) == 45
    assert not st["extracted"]["disc:1001"].get("hidden")
    assert "5 Oca" in tg.last and "kaldırıldı" not in tg.last


def test_removed_announcement_on_a_later_page_is_still_noticed(env, monkeypatch):
    mb, moodle, tg = env
    wrap(mb, monkeypatch, moodle, paged_forum(45))
    run(mb, "run")
    wrap(mb, monkeypatch, moodle, paged_forum(45, removed={1}))
    for _ in range(3):
        new_day(mb)
        run(mb, "run", "--force")
    st = json.loads(mb.STATE_FILE.read_text())
    assert st["extracted"]["disc:1001"]["hidden"] is True
    assert "kaldırıldı" in tg.last and "5 Oca" not in tg.last


def test_forum_too_long_to_read_fully_hides_nothing(env, monkeypatch):
    mb, moodle, tg = env
    monkeypatch.setattr(mb, "FORUM_PAGES", 1)                       # pretend the forum never ends
    wrap(mb, monkeypatch, moodle, paged_forum(40))
    run(mb, "run")
    wrap(mb, monkeypatch, moodle, paged_forum(41))                  # a new post pushes #1 off the page
    for _ in range(4):
        new_day(mb)
        run(mb, "run", "--force")
    st = json.loads(mb.STATE_FILE.read_text())
    assert not st["extracted"]["disc:1001"].get("hidden")
    assert "kaldırıldı" not in tg.last


def test_notification_that_scrolled_out_is_not_reported_as_removed(env, monkeypatch):
    mb, moodle, tg = env
    notifs = [{"id": 9, "subject": "IE 202.01: Midterm", "smallmessage": "Posted: the midterm is on November 17.",
               "timecreated": NOW - DAY}]

    def answer(fn, p):
        if fn == "message_popup_get_popup_notifications":
            return {"notifications": notifs}
    wrap(mb, monkeypatch, moodle, answer)
    run(mb, "run")
    notifs.clear()                                                   # 50 newer notifications pushed it out
    for _ in range(3):
        new_day(mb)
        run(mb, "run", "--force")
    assert "kaldırıldı" not in tg.last


# ------------------------------------------------------------------ messages

def test_gist_gets_to_the_point(mb):
    text = ("Gönderen: T\nTarih: x\n\nDear Students,\n Please note that starting next week, all Tuesday lectures for "
            "Sections 01 and 02 will take place in classroom ET01 , located in the ETA-B Block (Educational "
            "Technologies Building) on North Campus .\n Your schedule for other lecture days remains unchanged.")
    g = mb.gist(text)
    assert g.startswith("Starting next week, all Tuesday lectures") and "classroom ET01, located" in g
    assert len(g) <= 120
    assert mb.gist("This is a reminder that the lab starts at 9 .") == "The lab starts at 9."
    assert mb.gist("Office hours moved to TB215. See you there.") == "Office hours moved to TB215."
    assert mb.gist("Note that.") == "Note that."                     # nothing left after the lead-in: keep it


def test_token_help_points_to_the_right_place(env, monkeypatch):
    mb, moodle, tg = env
    moodle.mode = "token"
    monkeypatch.setattr(mb, "IN_CLOUD", True)
    run(mb, "run")
    assert "Secrets and variables" in tg.last and mb.SECRET_NAME in tg.last and ".env" not in tg.last
    tg.sent.clear()
    mb.STATE_FILE.unlink()                                           # a new day, on the Mac
    monkeypatch.setattr(mb, "IN_CLOUD", False)
    run(mb, "run")
    assert "~/moodle-brief/.env" in tg.last and "Secrets" not in tg.last


def test_connection_cut_mid_response_is_retried_not_a_crash(mb, monkeypatch):
    calls = []

    class R:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"userid": 7}

    def post(url, data=None, timeout=None):
        calls.append(1)
        if len(calls) == 1:
            raise mb.requests.exceptions.ChunkedEncodingError("connection broken")
        return R()
    m = mb.Moodle("https://moodle.example", "t")
    monkeypatch.setattr(m.s, "post", post)
    assert m.call("core_webservice_get_site_info") == {"userid": 7} and len(calls) == 2
