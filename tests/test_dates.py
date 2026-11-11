"""Date extraction from free-text announcements (the part most likely to be wrong)."""
import pytest

from conftest import ts

POSTED_MON = ts(2026, 11, 2, 10)  # announcement posted Monday 2 Nov 2026


def simple(mb, text, posted=None, title=""):
    out = []
    for e in mb.regex_dates(text, posted, title):
        row = (e["date"], e["time"], e["type"])
        if e.get("weekday_mismatch"):
            row += ("WEEKDAY_MISMATCH",)
        out.append(row)
    return out


CASES = [
    # (name, text, posted, title, expected)
    ("turkish date + time", "Arkadaşlar, ara sınav 18 Kasım Çarşamba saat 18:00'de NH101'de.", None, "",
     [("2026-11-18", "18:00", "midterm")]),
    ("english ordinal", "The midterm exam will be held on November 25th at 17.30 in BM A2.", None, "",
     [("2026-11-25", "17:30", "midterm")]),
    ("uppercase MIDTERM (Turkish lowercasing trap)", "Dear students, the MIDTERM (6.11.2026) will be at 18:00.", None, "",
     [("2026-11-06", "18:00", "midterm")]),
    ("moved from/to keeps only the new date", "The midterm has been moved from November 11 to November 17, 17:00.", None, "",
     [("2026-11-17", "17:00", "midterm")]),
    ("turkish 'yerine'", "Ara sınav 11 Kasım yerine 17 Kasım'da saat 17:00'de yapılacak.", None, "",
     [("2026-11-17", "17:00", "midterm")]),
    ("US month/day resolved by weekday", "Quiz 2 will be on 11/06/2026 (Friday).", None, "",
     [("2026-11-06", None, "quiz")]),
    ("day/month with weekday", "2nd exam will be held on 06/11/2026 (Friday).", None, "",
     [("2026-11-06", None, "exam")]),
    ("weekday contradicts date", "Midterm on November 18 (Thursday).", None, "",
     [("2026-11-18", None, "midterm", "WEEKDAY_MISMATCH")]),
    ("pm time", "Final exam: December 20, 2 pm, NH 101.", None, "",
     [("2026-12-20", "14:00", "final")]),
    ("time before date", "Quiz at 09:15 on Nov 12.", None, "",
     [("2026-11-12", "09:15", "quiz")]),
    ("grades are not the exam", "Quiz 1 grades were announced on 3 November.", None, "",
     [("2026-11-03", None, "other")]),
    ("topics are not the exam", "Midterm topics will be discussed on November 9 in PS.", None, "",
     [("2026-11-09", None, "other")]),
    ("objection deadline is not the exam", "Quiz 1 objection until November 7.", None, "",
     [("2026-11-07", None, "review")]),
    # after an exam: paper review / objection sessions are not the exam itself
    ("exam review session is not the midterm",
     "You can find your midterm grade on the Moodle page.\n"
     "The silent midterm exam review session will be on Wednesday, November 11th, between 13.00-16.00 at the following places:",
     None, "Midterm Grades and Review Session Details", [("2026-11-11", "13:00", "review")]),
    ("midterm exam grades", "Midterm exam grades will be discussed on November 12.", None, "",
     [("2026-11-12", None, "other")]),
    ("paper viewing", "Final exam paper viewing is on December 28 at 10:00.", None, "",
     [("2026-12-28", "10:00", "review")]),
    ("a real midterm is still a midterm", "The Midterm Exam will be on Monday, November 16th, at 17.00.", None, "",
     [("2026-11-16", "17:00", "midterm")]),
    ("numbered midterm exam", "Midterm exam 2 is on December 7 at 17:00.", None, "",
     [("2026-12-07", "17:00", "midterm")]),
    ("a lab named as the room is not a lab session",
     "The objection session for Quiz 1 will be held on Monday, November 16, from 15:00 to 17:00 at the BUFAIM Lab (M2142).",
     None, "", [("2026-11-16", "15:00", "review")]),
    ("which session it is comes from the previous sentence",
     "The time for tomorrow's exam review and grading objections session has been updated. "
     "The session will now take place on November 13, between 09:30 and 11:00 , at Sesdyn Lab (M3230).",
     None, "", [("2026-11-13", "09:30", "review")]),
    ("a real lab is still a lab", "Lab 3 will be held on November 12 at 14:00.", None, "",
     [("2026-11-12", "14:00", "lab")]),
    ("'in the lab on' is still a lab", "We will meet in the lab on November 12 at 14:00.", None, "",
     [("2026-11-12", "14:00", "lab")]),
    ("'will be announced' is not the event", "Quiz 2 date will be announced on November 10.", None, "",
     [("2026-11-10", None, "other")]),
    ("seat assignment is not homework",
     "You will be assigned specific classes and seats for the exam. The assignment will be announced tomorrow morning.",
     POSTED_MON, "", []),
    ("relative: yarınki", "Yarınki quiz 10:00'da NH101'de.", POSTED_MON, "",
     [("2026-11-03", "10:00", "quiz")]),
    ("relative: this Friday", "Reminder: quiz this Friday at 17:30.", POSTED_MON, "",
     [("2026-11-06", "17:30", "quiz")]),
    ("relative: gelecek hafta", "Ödev teslimi gelecek hafta çarşamba.", POSTED_MON, "",
     [("2026-11-11", None, "assignment")]),
    ("explicit date wins over relative", "Tomorrow we announce: midterm on Nov 17.", POSTED_MON, "",
     [("2026-11-17", None, "midterm")]),
    ("generic 'exam' refined from title", "The exam will be held on November 17, from 17:00 to 19:00, in M100.",
     None, "Midterm Date Updated", [("2026-11-17", "17:00", "midterm")]),
    ("header lines are ignored", "Gönderen: X\nTarih: 2026-11-02 10:00 Pazartesi\n\nSlides uploaded.", POSTED_MON, "", []),
    ("version numbers are not dates", "Use Python v3.11 and pandas 2.10.", None, "", []),
    ("room numbers are not dates", "Lecture moved to room 12.10 permanently.", None, "", []),
    ("syllabus section numbers are not dates",
     "Midterm 1 topics:\n• 2.1 Rates of Change\n• Chapter 3 (sections 3.3 to 3.11)\n• Section 4.5 and 8.4", None, "", []),
]


@pytest.mark.parametrize("name,text,posted,title,expected", CASES, ids=[c[0] for c in CASES])
def test_regex_dates(mb, name, text, posted, title, expected):
    assert simple(mb, text, posted, title) == expected
