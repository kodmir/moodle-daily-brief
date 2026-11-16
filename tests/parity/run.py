"""Python <-> iPhone parity: the two implementations must read the same text the same way.

Generates a few thousand announcement-like sentences, event sets, course names, HTML snippets and grades,
runs them through moodle_brief.py and docs/moodle-brief.js (via Node), and fails on any difference.

    python tests/parity/run.py [seed]
"""
import sys, os, json, random, subprocess, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
for k in ("ANTHROPIC_API_KEY", "BRIEF_SECRETS", "MOODLE_TOKEN"): os.environ.pop(k, None)
from datetime import datetime as _dt
import moodle_brief as m
FROZEN = _dt(2026, 11, 16, 19, 30, tzinfo=m.TZ)
class FD(_dt):
    @classmethod
    def now(cls, tz=None): return FROZEN.astimezone(tz) if tz else FROZEN.replace(tzinfo=None)
m.datetime = FD
m.time.time = lambda: FROZEN.timestamp()
cases = []
TMP = Path(tempfile.mkdtemp())
# 2) synthetic sentences
rnd = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 7)
subj = ["The midterm", "Midterm 2", "Quiz 3", "The final exam", "Homework 4", "The project report", "Our lab session", "The make-up exam",
        "Vize", "Final sınavı", "Ödev 2", "Proje sunumu", "The objection session", "The review session", "Tomorrow's lecture", "PS 5", "2nd midterm", "Exam No: 3"]
verb = ["will be held on", "is on", "is due", "has been postponed to", "is rescheduled to", "takes place", "must be submitted by", "is moved to",
        "tarihinde yapılacaktır:", "şu tarihe ertelendi:", "son teslim", "will start at", "is cancelled on", "is scheduled for", "deadline:"]
def date():
    d, mo = rnd.randint(1, 31), rnd.randint(1, 12)
    en = ["January","February","March","April","May","June","July","August","September","October","November","December"][mo-1]
    tr = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"][mo-1]
    wd = rnd.choice(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi","Pazar"])
    return rnd.choice([f"{en} {d}", f"{en} {d}th", f"{d} {en}", f"{d} {tr}", f"{d} {tr} {wd}", f"{wd}, {en} {d}", f"{d}.{mo}.2026", f"{d:02d}/{mo:02d}/2026", f"{d}.{mo}",
                       f"{d}/{mo}", f"{en[:3]} {d}", f"{d} {en[:3]}", f"{en} {d}, 2026", f"{d} {tr} 2026", f"{d}.{mo:02d}.26", f"next {wd}", f"this {wd}", "tomorrow", "yarın",
                       "today", "bugün", f"on {wd}", f"{wd} günü", f"{en} {d}-{d+1}", f"{d} {en.lower()}", f"{d} {tr.lower()}", f"{d}th of {en}", f"{en.upper()} {d}",
                       f"{d} {tr}'da", f"{d} {tr}’de", f"{d}.{mo}.2027", f"{wd} ({d}.{mo})", f"{wd} {d}/{mo}"])
def tm():
    h, mi = rnd.randint(0, 23), rnd.choice([0, 0, 0, 30, 15, 45, 59, 10, 5])
    return rnd.choice(["", "", f" at {h}:{mi:02d}", f" at {h}.{mi:02d}", f", {h}:{mi:02d}-{(h+2)%24}:{mi:02d}", f" saat {h}:{mi:02d}'de", f" from {h}:{mi:02d} to {(h+2)%24}:00",
                       f" ({h}:{mi:02d})", f" at {h} pm", f" {h}:{mi:02d} in M1100", f" by {h}.{mi:02d}", f" {h}-{(h+2)%24}", f" @ {h}:{mi:02d}"])
tail = ["\n AÇ – İNCEBOY: M1100\n İPEK – ZELKA: M1170\n", "\nA-K: NH101\nL-Z: NH102", "\nM100: Abak - Çelik\nM1170: Demir - Öz\nM2171: Öztürk - Zorlu", "\nMonday - Friday: NH101\nA - C: NH102",
        " (Last week I mentioned 1st of December as the possible exam date, but we shifted 1 day)", " — daha önce 3 Aralık demiştim.", " We announced December 5 earlier.",
        " in room NH 304.", " at the BUFAIM Lab (M2142).", " Yer: KB301 ve KB302", " in IE202.", "\nRooms: M1100, M1170, M2171 or M2180", " at NOV 17", " in classroom (ET01)", " Salon: İB102", " in HW12", " at B-12",
        "", ".", " in M100 and M1170.", " Please be on time.", " (Section 3.2)", " due to the holiday.", " You may bring a calculator.", " See chapter 4.5 for details.",
        " Finally, good luck!", " For example, bring your ID.", " — rooms: NH101, NH102", "\nRegards,\nTA", " instead of the lecture.", " kapsam: bölüm 1-7", " v2.1 uploaded."]
lead = ["", "Dear all,\n", "Dear Students,\n\n", "Merhaba arkadaşlar,\n", "Please note that ", "IMPORTANT: ", "Gönderen: X\nTarih: 2026-11-10 10:00 Salı\n\n", "Reminder: ", "Hello,\n"]
for i in range(4000):
    n = rnd.choice([1, 1, 1, 2, 2, 3])
    t = rnd.choice(lead) + " ".join(f"{rnd.choice(subj)} {rnd.choice(verb)} {date()}{tm()}{rnd.choice(tail)}" for _ in range(n))
    posted = int(FROZEN.timestamp()) - rnd.randint(0, 40) * 86400 if rnd.random() < 0.8 else None
    cases.append(("dates", [t, posted, rnd.choice(["", "Midterm", "Quiz 2 Date", "Announcement", "Final Exam"]), rnd.choice(["IE202", "MATH101", ""])]))
    if i % 4 == 0: cases.append(("gist", [t]))
# 3) html, course names, diff
htmls = ["<p>Dear <b>all</b>,</p><p>Quiz&nbsp;2 is on <strong>Monday</strong> , 17:00.</p>", "<ul><li>a</li><li>b &amp; c</li></ul><br/>x&lt;y", "<a href='x'>link</a> text<br>line2<div>d</div>",
         "plain &#39;quoted&#39; &quot;x&quot; &uuml;", "<script>alert(1)</script>ok<style>p{}</style>", "<p>İstanbul&rsquo;da ŞIK</p>", "", "<table><tr><td>1</td><td>2</td></tr></table>", "a<br />\n\n\n\nb"]
for x in htmls: cases.append(("html", [x]))
for sn in ["2026/2027-1 IE  306.01", "2026/2027-1 MATH101.05", "IE 202.01 OPERATIONS RESEARCH I", "AD 216", "2025/2026-2 HTR 311.02", "PHYS101L.03", "Turkish for Foreigners", "CMPE150", "2026/2027-1 EC 101.01"]:
    cases.append(("short", [{"shortname": sn, "fullname": sn}]))
for a, b in [("a\nb\nc", "a\nb\nc\nd"), ("Due: 1", "Due: 2"), (None, "x"), ("x", ""), ("Gönderen: A\nTarih: t\n\nold line", "Gönderen: A\nTarih: t2\n\nnew line\nsecond"), ("R1 · R2", "R1 · R2 · R3")]:
    cases.append(("diff", [a, b]))
for g in [{"gradeformatted": "85.00", "grademax": 100}, {"gradeformatted": "28.00", "grademax": 40}, {"gradeformatted": "AA", "grademax": 100}, {"gradeformatted": "85.50 %", "grademax": 100},
          {"gradeformatted": "7,5", "grademax": 10}, {"gradeformatted": "-", "grademax": 100}, {"gradeformatted": "31.00", "grademax": "100.00"}, {"gradeformatted": "12.345", "grademax": 20}]:
    cases.append(("grade", [g]))
for sn in ["Fall 2026 IE 202 Section 1", "ie202", "  IE202  ", "MATH 101E.01", "Ç ĞİÖ 123", "HTR311", "ABCDEFG123", "A1", "IE 20", "EC 101.01 (Micro)", "2026/2027-1 IE306&amp;IE307", "PE 1A1"]:
    cases.append(("short", [{"shortname": sn, "fullname": sn}]))
# 4) merging: random exact + text events
def rev(i):
    d = _dt(2026, 11, rnd.randint(14, 30)); c = rnd.choice(["IE202", "AD216", "MATH101"])
    title = rnd.choice(["Homework 5", "Quiz 3", "Midterm", "Meeting with your Teacher", "Term Project", "Survey (kapanış)", "Final Exam", "Lab 2", "Midterm Project Report"])
    return c, title, d
for i in range(600):
    exact, docs = [], []
    for _ in range(rnd.randint(0, 4)):
        c, title, d = rev(i); t = rnd.choice(["23:59", "00:00", "17:00", "13:00", "09:30"])
        exact.append({"course": c, "title": title + rnd.choice(["", " is due", " closes"]), "type": rnd.choice(["assign", "ödev teslimi", "quiz kapanış", "quiz", "feedback", "scheduler", "course", "user"]),
                      "date": d.strftime("%Y-%m-%d"), "time": t, "certainty": "exact", "source": rnd.choice(["moodle ödev", "moodle", "moodle takvim", "moodle quiz"])})
    for _ in range(rnd.randint(0, 5)):
        c, title, d = rev(i)
        docs.append({"course": rnd.choice([c, c, "Bildirim"]), "type": rnd.choice(["midterm", "final", "quiz", "exam", "assignment", "project", "review", "class_change", "lab", "presentation", "other"]),
                     "date": d.strftime("%Y-%m-%d"), "time": rnd.choice([None, "17:00", "13:00", "23:59", "00:00"]), "title": rnd.choice([title, "The " + title.lower() + " will be held soon", "2nd midterm", "Quiz 3 on Monday"]),
                     "certainty": "approximate", "item": rnd.choice(["disc:1", "disc:2", "assign:5", "mod:7", "cal:9", "notif:3"]), "source": rnd.choice([title, "Announcement"]),
                     "posted": int(FROZEN.timestamp()) - rnd.randint(0, 20) * 86400})
    cases.append(("merge", [exact, docs]))
(TMP / "cases.jsonl").write_text("\n".join(json.dumps({"fn": f, "args": a}, ensure_ascii=False) for f, a in cases), encoding="utf-8")
subprocess.run(["node", str(HERE / "js_side.js"), str(TMP / "cases.jsonl"), str(int(FROZEN.timestamp() * 1000))], check=True, env={**os.environ, "TZ": "Europe/Istanbul"})
js = [json.loads(l) for l in (TMP / "cases.jsonl.out").read_text(encoding="utf-8").split("\n")]
def py(fn, a):
    if fn == "dates": return [[e["type"], e["date"], e["time"], e["certainty"], bool(e.get("weekday_mismatch")), e["title"], e.get("place"), e.get("seats")] for e in m.regex_dates(a[0], a[1], a[2], a[3] if len(a) > 3 else "")]
    if fn == "gist": return m.gist(a[0])
    if fn == "isExam": return m.is_exam(a[0])
    if fn == "slot": return m.exam_slot(a[0])
    if fn == "html": return m.html_to_text(a[0])
    if fn == "short": return m.short_course(a[0])
    if fn == "diff": return m.diff_summary(a[0], a[1])
    if fn == "grade": return m.fmt_grade(a[0])
    if fn == "merge":
        import copy
        ctx = {"moodle_calendar_and_deadlines": copy.deepcopy(a[0]), "dates_found_in_documents": m.supersede(copy.deepcopy(a[1]))}
        return [[e["course"], e["type"], e["date"], e.get("_t"), e.get("text_dates"), e.get("changed_from")] for e in m.merged_events(ctx)]
diff = {}
crash = 0
for (fn, a), j in zip(cases, js):
    try: p = py(fn, a)
    except Exception as e: p = {"PYERR": repr(e)}; crash += 1
    if "err" in j: crash += 1
    if p != j.get("ok", j):
        diff.setdefault(fn, []).append((a, p, j))
from collections import Counter
print(len(cases), "cases", dict(Counter(f for f, _ in cases)), "| differences:", {k: len(v) for k, v in diff.items()} or "none", "| crashes:", crash)
show = int(os.environ.get("SHOW", "4"))
for fn, v in diff.items():
    for a, p, j in v[:show]:
        print(f"\n[{fn}] {json.dumps(a, ensure_ascii=False)[:330]}\n   PY: {json.dumps(p, ensure_ascii=False)[:420]}\n   JS: {json.dumps(j, ensure_ascii=False)[:420]}")

sys.exit(1 if diff or crash else 0)
