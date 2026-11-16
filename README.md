# moodle-daily-brief

[![Tests](https://github.com/kodmir/moodle-daily-brief/actions/workflows/tests.yml/badge.svg)](https://github.com/kodmir/moodle-daily-brief/actions/workflows/tests.yml)
![Python](https://img.shields.io/badge/python-3.9%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)

**A daily Telegram brief of everything that happened on your university's Moodle: today's deadlines,
this week's events, the next exam, and every new announcement, so you never miss a date change buried in a forum post.**

Runs for free on GitHub Actions, with no server and no laptop needed. Built for Boğaziçi University's Moodle, and
works with any Moodle site that has the mobile web service enabled.

```
☀️ 16 Kas Pazartesi

🎯 SINAVLAR                                   ← upcoming exams, with the room when the post names it
• MATH201 Quiz 2 · 17 Kas Sal 10:00 (yarın)
• IE310 Ara sınav ❔ · 25 Kas Çar 17:00 · NH101, NH102 (9 gün)
   ⚠️ tarih değişti (eskisi 20 Kas)            ← a newer announcement moved the exam

📅 BU HAFTA                                   ← this week
• yarın MATH201 Ders değişikliği — Tomorrow's lecture is cancelled ❔
• 18 Kas Çar 23:59 EC204 Ödev — It is due November 18 at 23:59 via Moodle ❔
• 20 Kas Cum 23:59 IE310 Homework 3

📊 NOTLAR                                     ← new grades, with the class average if Moodle shows it
• EC204 Quiz 1: 82/100 · ort. 67.4

📣 DUYURULAR                                  ← not the text of each post, only the fact that matters
• IE310 · Midterm Date Updated
   → Ara sınav 25 Kas Çar 17:00 · NH101, NH102
• EC204 · Problem Set 4
   → Ödev 18 Kas Çar 23:59
• EC204 · Quiz 1 grades
• MATH201 · Tomorrow's lecture is cancelled
   → Ders değişikliği yarın

🆕 YENİ İÇERİK
• IE310 dosya: Lecture 9 slides

❔ = extracted from announcement text, double-check
```

And in the evening, only if something is due tonight or tomorrow:

```
🌙 Yarın · 17 Kas Salı
• 10:00 MATH201 Quiz 2
• 17:00 IE202 Ara sınav ❔ · M100, M1170

⏳ Bu gece
• 23:59 AD216 Homework 4                       ← not shown once it is submitted
```
<sub>Output of `python demo.py` (fictional courses). The brief is in Turkish.</sub>

## Why

Course information is scattered across Moodle: the calendar, assignment pages, forum posts,
replies under those posts, and PDFs. Exam dates are often only written in an announcement, and they get
**changed** in a later announcement. Moodle's own notifications don't summarise any of this, and they don't
tell you that "the midterm is now on the 17th, not the 11th".

## How it works

```mermaid
flowchart LR
    A[cron-job.org<br/>07:30 daily] -->|workflow_dispatch| B[GitHub Actions<br/>private repo]
    B --> C[moodle_brief.py]
    C -->|REST web service| D[(Moodle)]
    C -->|sendMessage| E[Telegram]
    C -->|commit| F[data/<br/>state + append-only archive]
    F -.->|next run| C
```

1. **Collect** everything via Moodle's web service API: course contents, files, announcements and forum
   replies, assignments, quizzes, calendar events, notifications and grades.
2. **Diff** against the previous run's state, so new and *edited* items are detected by content hash.
3. **Extract dates** from free-text announcements with a rule-based parser (Turkish and English).
4. **Merge** these with Moodle's structured dates, resolve conflicts, and render one compact brief.
5. **Send** it to Telegram and **commit** the state back to the repo, so the next run has memory.

## Interesting problems solved

**Dates in free text.** The parser handles Turkish and English (`18 Kasım`, `November 25th`, `06.11`, `2 pm`,
`yarınki quiz`, `this Friday`) and many traps:
- *"moved from Nov 11 to Nov 17"* / *"11 Kasım yerine 17 Kasım"*: only the new date counts.
- *"11/06/2026 (Friday)"*: day/month vs. month/day is resolved by checking the weekday name.
- *"Quiz 1 grades on Nov 3"*, *"midterm topics"*, *"the assignment will be announced tomorrow"*: these are
  not events.
- *"The exam will be held on Nov 17"*: the generic "exam" is refined to *midterm* from the previous
  sentence or the post title.
- Syllabus numbering (`2.1`, `Section 4.5`), version numbers and room numbers are not dates.
- *"Quiz 2 may be postponed"* is not the 2nd of May, *"Finally, …"* is not a final, *"no class due to the
  holiday"* is not a deadline, and *"at 9.12"* is a time, not 9 December.
- An assignment called *"Midterm Project Report"* is a deadline, not an exam.
- *"in M100 and M1170"*, *"at the BUFAIM Lab (M2142)"*, *"Yer: KB301"* are the exam's rooms; *"in IE202"* and
  *"at NOV 17"* are not.
- *"…on 2nd of December (last week I mentioned 1st of December as the possible date, but…)"*: the date that is
  only mentioned to explain the change is not a second exam.
- When announcements disagree, the most recently posted one wins, and the brief shows ⚠️ with the old date.
  A later reminder that repeats the new date does not bring the warning back.

**Never send a wrong brief.** Errors are classified as permanent (a disabled Moodle feature: skip that section),
transient (network, maintenance: abort without sending, retry later) or auth (bad token: notify the user once a day).
A half-fetched Moodle never produces an "all clear" message.

**Never delete anything.** Every version of every item is appended to `data/archive.jsonl`. Edited
announcements keep their previous versions. Items removed from Moodle are *hidden* (and reported), never
deleted, and only after 3 consecutive clean runs, so a temporary outage can't hide anything.

**Signal, not noise.** One upload in Moodle shows up as a module, a file and sometimes a calendar entry;
these are merged into one line. Updated items say *what* changed (`Recordings — + R8`) instead of a bare
"updated". New or changed grades get their own section, and grades that existed before tracking started
stay quiet.

**"Changed" means the content changed.** Moodle bumps an item's version without touching its content: when a
deadline passes, the label *Closes:* becomes *Closed:*; when someone replies, the thread's modified time
moves. The brief compares against the version you last saw and stays quiet when title and text are the same.

**When Moodle disagrees with itself, say so.** If an assignment closes on the 16th but its own description
says "due November 15", that is one line with a ⚠️, not two unrelated-looking deadlines. Submitted
assignments are marked ✓.

**One bad record costs one record.** Each item from Moodle is read on its own: a module, post or calendar entry
in an unexpected shape (a plugin, an older Moodle) is skipped and logged, and the rest of the brief still goes
out. In such a run nothing is treated as removed, because what is missing is unknown.

**Two implementations, one behaviour.** The Telegram bot (Python) and the iPhone script (JavaScript) share no
code. A parity test generates thousands of announcement-like sentences, event sets, course names and grades,
runs them through both, and fails on any difference. Seeded fuzz tests feed both with hostile text and
corrupted Moodle responses: a run must end with a brief or a clean "retry later", never a crash, and whatever
is sent must be valid Telegram HTML within the size limit. (The first run of each found real bugs: a character
reference like `&#99999999;` in a post crashed the iPhone script, and an over-long line was cut in the middle of
a `<b>` tag.)

**Your room, not all the rooms.** When a post splits the rooms by surname (`AÇ – İNCEBOY: M1100`,
`İPEK – ZELKA: M1170`), the brief shows the reader's own room, with the range so it can be checked:
`· M1170 (soyadına göre: İPEK–ZELKA)`. Ranges are compared in Turkish alphabetical order (Ö sorts between O and P,
İ after I). A surname outside every range, or inside two, gets no guess and all rooms are shown. The surname
comes from Moodle at run time and is never written to the state or the archive.

**Scheduling you can trust.** GitHub's built-in cron didn't fire at all on a new repo, so an external
scheduler triggers the workflow. The script is idempotent (one brief per day, lock file, retries until noon),
so duplicate or late triggers are harmless.

**Privacy by default.** Credentials live only in GitHub Secrets and never appear in logs. The workflow
**refuses to run in a public repository**, because the bot commits your Moodle content to `data/`.

## Set up your own (about 10 minutes, free)

1. **Use this template → Create a new repository → choose _Private_.**
2. Get your **Moodle token**: Moodle → Preferences → Security keys → *Moodle mobile web service*.
3. Create a **Telegram bot** with [@BotFather](https://t.me/BotFather) and send it `/start`. To get your chat ID,
   open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
4. In your private repo: **Settings → Secrets and variables → Actions → New repository secret**,
   name it `BRIEF_SECRETS`, with the value:
   ```
   moodle_token: <your moodle token>
   telegram_bot_token: <your bot token>
   telegram_chat_id: <your chat id>
   ```
   For a Moodle site other than Boğaziçi, add a repository **variable** `MOODLE_URL`.
5. **Actions → Morning brief → Run workflow.** The brief arrives in about a minute.
6. *(Recommended)* For an exact daily time, create a free job on [cron-job.org](https://cron-job.org):
   `POST https://api.github.com/repos/<you>/<repo>/actions/workflows/brief.yml/dispatches` with the headers
   `Authorization: Bearer <fine-grained token with Actions: read & write on this repo only>`,
   `Accept: application/vnd.github+json` and the body `{"ref":"main","inputs":{"mode":"scheduled"}}`.

**Run locally instead (macOS):** `./install.sh` creates a virtualenv and a `launchd` job (every 30 min, sends
once per day after `SEND_TIME`). Configuration goes in `.env` (see `.env.example`).

**Evening reminder.** After `REMINDER_TIME` (default 20:00) a second, short message lists tomorrow's exams and
deadlines and anything still due tonight. Submitted assignments are left out, and if there is nothing to say,
nothing is sent. Set the repository variable (or `.env` line) `REMINDER_TIME=off` to disable it, or run
`python moodle_brief.py remind` to ask for it at any time. It is sent by the first scheduled run between
`REMINDER_TIME` and 23:00; GitHub's own scheduler can be hours late, so for an exact time add a second
cron-job.org job at 20:00 with the same request as the morning one.

## Try it without any account

```bash
pip install -r requirements.txt
python demo.py      # fake Moodle, prints the brief
pytest -q                     # 150 tests: date parsing, failure modes, grades, reminders, fuzz
python tests/parity/run.py    # Python vs. iPhone script on 5,600 generated cases (needs Node)
for f in tests/ios/*.js; do node "$f"; done    # the iPhone port's own suites
```

## iPhone version

`docs/moodle-brief.js` is a port for [Scriptable](https://scriptable.app): the same parser and rules running
entirely on the phone, with a morning notification, instant alerts for new announcements and grades, deadline
reminders that go quiet once an assignment is submitted, a reminder the evening before each exam (with the room), and a home-screen widget. Sign-in happens on Moodle's own page (SSO); the token stays in the device keychain.
Install page: https://kodmir.github.io/moodle-daily-brief/

## Optional: Claude mode

With `ANTHROPIC_API_KEY` set, PDFs, Word files and slides are read too (e.g. exam dates that appear only in a
syllabus PDF), and the brief is written by Claude. Without a key the tool is fully rule-based and costs nothing.

## Limitations

- Dates from free text are heuristics, which is why they are marked ❔ in the brief. Exact dates come from Moodle's
  own calendar, assignments and quizzes.
- In free mode, the contents of files (PDF, slides) are not read, only their names.
- Requires your Moodle site to allow the *Moodle mobile web service* (most do, because the official app uses it).
- Code comments and the brief text are in Turkish.

## Project layout

```
moodle_brief.py        collection, diffing, date extraction, rendering, Telegram, state
docs/                  install page (GitHub Pages) + the iPhone/Scriptable port
docs/version.json      Latest published version; the script checks it once a day (a test keeps it in sync)
tests/ios/             Node tests for the iPhone port (fake Moodle, fake Scriptable APIs), incl. a fuzz run
tests/parity/          Python vs. iPhone script: same input, same answer
demo.py                offline demo with a fake Moodle
tests/                 pytest suite (frozen clock, fake Moodle and Telegram)
.github/workflows/     brief.yml (morning brief + evening reminder), tests.yml (CI: Python 3.9/3.12, Node, parity)
install.sh             local macOS setup (launchd)
```

## License

MIT © 2026 Emir Eymen Özbey
