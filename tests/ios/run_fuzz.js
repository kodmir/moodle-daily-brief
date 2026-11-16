// node tests/ios/run_fuzz.js — the iPhone script against hostile text and malformed Moodle responses.
// Whatever Moodle sends, a run must finish (bad records are skipped) or stop as "no identity, retry later".
// It must never throw. Seeds are fixed, so a failure is reproducible.
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
global.Notification = class { setTriggerDate() {} async schedule() {} static removePending() {} static async allPending() { return [] } }
global.URLScheme = { forRunningScript: () => "scriptable:///run/x" }
function rng(seed) { let s = seed * 2654435761 % 4294967296 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }
const NASTY = ["<b>bold", "a & b", "</b></i>", "<a href=\"x\">", "Tom & Jerry <3", "x".repeat(5000), "", "   ", "\n\n\n", "İŞĞÜÖÇ ığüşöç", "🎯🔥", "&amp;amp;", "&#99999999;", "&#x110000;", "<script>alert(1)</script>",
  "Midterm on November 9 at 17:00 in M100", "Quiz 31.02.2026", "due 99/99/9999", "00:00", "24:61", "‮\u0000evil", "a\tb\rc", "%s %d {0} ${x}", "https://x.y/?a=1&b=2\"onload=\"x",
  "Final exam: 5 Ocak 2027 Salı 09:00", "1.1.1.1", "tomorrow tomorrow tomorrow", "0/0", "-1", "9".repeat(40), "Re: ".repeat(30), "\\", "<<<>>>", "&lt;b&gt;", "&uuml;&rsquo;&nbsp;&bogus;"]
const JUNK = [null, "", 0, -1, 1e15, [], {}, "x", 3.7, true, ["x"], { a: 1 }, "9".repeat(30), NaN, undefined]
const T0 = new Date(2026, 10, 5, 10, 0), NOW = Math.floor(T0 / 1000), DAY = 86400
function rich(R) {
  const pick = a => a[Math.floor(R() * a.length)], ri = (a, b) => a + Math.floor(R() * (b - a + 1))
  const txt = () => pick(["The midterm will be held on November 17 at 17:00, in M100.", "<p>Homework 3 is due <b>November 9</b> , 23:59.</p>", "Quiz 2 on Monday.", "Dear all,<br>no class tomorrow.",
    "Vize 25 Kasım Çarşamba 18:00", "Slides uploaded.", "The objection session will be on November 10 at 15:00.", pick(NASTY)])
  const courses = ["IE  202", "MATH101", "AD 216", "IE 306"].map((c, i) => ({ id: i + 1, shortname: `2026/2027-1 ${c}.0${i + 1}`, fullname: c, startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY }))
  const mods = cid => Array.from({ length: ri(0, 6) }, (_, j) => ({ id: cid * 1000 + j, modname: pick(["resource", "assign", "quiz", "feedback", "label", "url", "folder", "forum", "page", "scheduler"]),
    name: pick(["Slides " + j, "Homework " + j, "Quiz " + j, txt()]), description: R() < .5 ? txt() : null, url: "https://m/mod/view.php?id=" + (cid * 1000 + j),
    dates: Array.from({ length: ri(0, 2) }, () => ({ label: pick(["Opens:", "Closes:", "Due:", "Opened:", "Kapanıyor:"]), timestamp: NOW + ri(-3, 9) * DAY, dataid: pick(["duedate", "timeopen", "timeclose", "", null]) })),
    contents: Array.from({ length: ri(0, 3) }, (_, k) => ({ type: "file", filename: `f${j}_${k}.pdf`, fileurl: "https://m/f.pdf", filesize: 1000 + k, timemodified: NOW - k * DAY })) }))
  return {
    core_webservice_get_site_info: p => ({ userid: 7, fullname: "T" }),
    core_enrol_get_users_courses: p => courses,
    core_course_get_contents: p => Array.from({ length: ri(1, 3) }, (_, s) => ({ id: s, name: "Week " + s, summary: R() < .3 ? txt() : "", modules: mods(+p.courseid) })),
    mod_assign_get_assignments: p => ({ courses: courses.map(c => ({ id: c.id, assignments: Array.from({ length: ri(0, 3) }, (_, a) => ({ id: c.id * 10 + a, cmid: 1, name: "Homework " + a, duedate: NOW + ri(-2, 12) * DAY, intro: txt() })) })) }),
    mod_assign_get_submission_status: p => ({ lastattempt: { submission: { status: pick(["submitted", "new", "draft"]) } } }),
    mod_quiz_get_quizzes_by_courses: p => ({ quizzes: Array.from({ length: ri(0, 3) }, (_, q) => ({ id: q, course: ri(1, 4), coursemodule: q, name: "Quiz " + q, intro: txt(), timeopen: NOW + ri(-2, 5) * DAY, timeclose: NOW + ri(0, 9) * DAY })) }),
    core_calendar_get_calendar_events: p => ({ events: Array.from({ length: ri(0, 5) }, (_, e) => ({ id: e, name: pick(["Homework 1 is due", "Quiz 1 opens", "Meeting", txt()]), courseid: ri(0, 4), timestart: NOW + ri(-1, 20) * DAY, modulename: pick(["assign", "quiz", "", null]), eventtype: pick(["due", "course", "user"]), description: txt(), instance: e })) }),
    mod_forum_get_forums_by_courses: p => courses.map(c => ({ id: 50 + c.id, course: c.id, type: pick(["news", "general"]) })),
    mod_forum_get_forum_discussions: p => ({ discussions: +p.page ? [] : Array.from({ length: ri(0, 5) }, (_, d) => ({ discussion: p.forumid * 100 + d, id: p.forumid * 1000 + d, subject: pick(["Midterm", "Quiz 2 Date", txt()]), message: txt(), created: NOW - ri(0, 20) * DAY, modified: NOW - ri(0, 3) * DAY, userfullname: pick(["Instructor", pick(NASTY)]), numreplies: ri(0, 2), attachments: R() < .2 ? [{ filename: "a.pdf", fileurl: "https://m/a.pdf", filesize: 5, timemodified: NOW }] : [] })) }),
    mod_forum_get_discussion_posts: p => ({ posts: [{ id: p.discussionid * 10, parentid: 0, message: "first" }, { id: p.discussionid * 10 + 1, parentid: p.discussionid * 10, subject: "Re: x", message: txt(), timecreated: NOW - 3600, author: { fullname: "TA" } }] }),
    message_popup_get_popup_notifications: p => ({ notifications: Array.from({ length: ri(0, 5) }, (_, n) => ({ id: n, subject: pick(["2026/2027-1 IE  202.01: Midterm", txt()]), smallmessage: txt(), fullmessage: txt(), timecreated: NOW - n * 3600, contexturl: "https://m/x" })) }),
    core_message_get_conversations: p => ({ conversations: Array.from({ length: ri(0, 2) }, (_, c) => ({ id: c, name: "x", members: [{ fullname: "Prof" }], messages: [{ id: c * 10, text: txt(), timecreated: NOW - c * 3600, useridfrom: 9 }] })) }),
    gradereport_user_get_grade_items: p => ({ usergrades: [{ gradeitems: Array.from({ length: ri(0, 3) }, (_, g) => ({ id: p.courseid * 100 + g, itemname: pick(["Midterm", "Quiz 1", txt()]), itemtype: "mod", graderaw: pick([85, 28.5, null, 0]), gradeformatted: pick(["85.00", "28.50", "-", "AA", ""]), grademax: pick([100, 40, 0, null]), gradedategraded: NOW - g * DAY, feedback: R() < .3 ? txt() : "", averageformatted: pick(["61.20", "-", null]) })) }] }),
  }
}
function mutate(o, R, p) {
  const pick = a => a[Math.floor(R() * a.length)]
  if (Array.isArray(o)) return R() < p / 3 ? pick(JUNK) : o.map(v => mutate(v, R, p))
  if (o && typeof o === "object") { const out = {}; for (const [k, v] of Object.entries(o)) { const r = R(); if (r < p / 2) continue; out[k] = r < p ? pick(JUNK.concat(NASTY)) : mutate(v, R, p) } return out }
  return R() < p / 2 ? pick(JUNK.concat(NASTY)) : o
}
;(async () => {
  const EXP = {}
  await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  const A = EXP.api, agg = {}
  A.setNow(() => T0)
  let runs = 0
  for (const P of [0, 0.03, 0.12]) for (let seed = 1; seed <= 60; seed++) {
    runs += 2
    const R = rng(seed + Math.round(P * 1000))
    let files = {}
    A.setFm({ documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b, fileExists: p => p in files || p === "/d/moodle-brief", createDirectory() {}, readString: p => files[p], writeString: (p, s) => { files[p] = s } })
    const st = A.loadState()
    for (let run = 0; run < 2; run++) {
      const resp = rich(R)
      A.setPost(async (url, body) => { const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent))); const f = resp[p.wsfunction]; return f ? mutate(f(p), R, P) : {} })
      let stage = "collect"
      try {
        const data = await A.collect("https://m", "tok", st.replyCache)
        stage = "ingest"; const fresh = A.ingest(st, data)
        stage = "buildModel"; const m = A.buildModel(st, T0)
        stage = "briefHtml"; const h = A.briefHtml(m)
        stage = "notificationText"; A.notificationText(m)
        stage = "saveState"; A.saveState(st)
        if (typeof h !== "string" || !h.includes("<")) throw new Error("empty html")
      } catch (e) {
        if (/kullanıcı bilgisi|TransientError/.test(String(e && e.name) + String(e && e.message)) && stage === "collect" && /bilgi/.test(e.message)) continue
        const where = ((e.stack || "").split("\n").find(l => /<anonymous>:\d+/.test(l)) || "").replace(/.*<anonymous>:(\d+):\d+.*/, "line $1").trim()
        const k = `${stage} | ${e.name}: ${String(e.message).slice(0, 90)} | ${where}`
        agg[k] = agg[k] || { n: 0, seed }; agg[k].n++
      }
    }
  }
  const rows = Object.entries(agg).sort((a, b) => b[1].n - a[1].n)
  for (const [k, v] of rows.slice(0, 20)) console.log("✗", String(v.n).padStart(4), k, " e.g. seed", v.seed)
  console.log(`\n${runs} çalıştırma, ${rows.reduce((s, r) => s + r[1].n, 0)} çökme`)
  process.exit(rows.length ? 1 : 0)
})().catch(e => { console.error("ÇALIŞMA HATASI:", e); process.exit(1) })
