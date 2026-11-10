// node test/run_tests.js  — Moodle Brief.js'i Scriptable olmadan test eder (TZ=Europe/Istanbul)
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
function load() {
  const EXP = {}
  new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  return EXP.api
}
let pass = 0, fail = 0
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function check(name, got, exp) {
  if (eq(got, exp)) pass++
  else { fail++; console.log("✗", name, "\n   got:", JSON.stringify(got), "\n   exp:", JSON.stringify(exp)) }
}
const FROZEN = new Date(2026, 10, 5, 10, 0)           // Per 5 Kasım 2026 10:00
const ts = (y, mo, d, h = 0, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi) / 1000)
const POSTED_MON = ts(2026, 11, 2, 10)

;(async () => {
  const A = await (async () => { const EXP = {}; await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP); return EXP.api })()
  A.setNow(() => new Date(FROZEN))
  const simple = (t, p = null, title = "") => A.regexDates(t, p, title).map(e => { const r = [e.date, e.time, e.type]; if (e.weekday_mismatch) r.push("WEEKDAY_MISMATCH"); return r })
  const CASES = [
    ["turkish date + time", "Arkadaşlar, ara sınav 18 Kasım Çarşamba saat 18:00'de NH101'de.", null, "", [["2026-11-18", "18:00", "midterm"]]],
    ["english ordinal", "The midterm exam will be held on November 25th at 17.30 in BM A2.", null, "", [["2026-11-25", "17:30", "midterm"]]],
    ["uppercase MIDTERM", "Dear students, the MIDTERM (6.11.2026) will be at 18:00.", null, "", [["2026-11-06", "18:00", "midterm"]]],
    ["moved from/to", "The midterm has been moved from November 11 to November 17, 17:00.", null, "", [["2026-11-17", "17:00", "midterm"]]],
    ["turkish yerine", "Ara sınav 11 Kasım yerine 17 Kasım'da saat 17:00'de yapılacak.", null, "", [["2026-11-17", "17:00", "midterm"]]],
    ["US month/day by weekday", "Quiz 2 will be on 11/06/2026 (Friday).", null, "", [["2026-11-06", null, "quiz"]]],
    ["day/month with weekday", "2nd exam will be held on 06/11/2026 (Friday).", null, "", [["2026-11-06", null, "exam"]]],
    ["weekday contradicts", "Midterm on November 18 (Thursday).", null, "", [["2026-11-18", null, "midterm", "WEEKDAY_MISMATCH"]]],
    ["pm time", "Final exam: December 20, 2 pm, NH 101.", null, "", [["2026-12-20", "14:00", "final"]]],
    ["time before date", "Quiz at 09:15 on Nov 12.", null, "", [["2026-11-12", "09:15", "quiz"]]],
    ["grades not exam", "Quiz 1 grades were announced on 3 November.", null, "", [["2026-11-03", null, "other"]]],
    ["topics not exam", "Midterm topics will be discussed on November 9 in PS.", null, "", [["2026-11-09", null, "other"]]],
    ["objection not exam", "Quiz 1 objection until November 7.", null, "", [["2026-11-07", null, "other"]]],
    ["will be announced", "Quiz 2 date will be announced on November 10.", null, "", [["2026-11-10", null, "other"]]],
    ["seat assignment", "You will be assigned specific classes and seats for the exam. The assignment will be announced tomorrow morning.", POSTED_MON, "", []],
    ["yarınki", "Yarınki quiz 10:00'da NH101'de.", POSTED_MON, "", [["2026-11-03", "10:00", "quiz"]]],
    ["this Friday", "Reminder: quiz this Friday at 17:30.", POSTED_MON, "", [["2026-11-06", "17:30", "quiz"]]],
    ["gelecek hafta", "Ödev teslimi gelecek hafta çarşamba.", POSTED_MON, "", [["2026-11-11", null, "assignment"]]],
    ["explicit wins", "Tomorrow we announce: midterm on Nov 17.", POSTED_MON, "", [["2026-11-17", null, "midterm"]]],
    ["refined from title", "The exam will be held on November 17, from 17:00 to 19:00, in M100.", null, "Midterm Date Updated", [["2026-11-17", "17:00", "midterm"]]],
    ["header lines", "Gönderen: X\nTarih: 2026-11-02 10:00 Pazartesi\n\nSlides uploaded.", POSTED_MON, "", []],
    ["version numbers", "Use Python v3.11 and pandas 2.10.", null, "", []],
    ["room numbers", "Lecture moved to room 12.10 permanently.", null, "", []],
    ["syllabus numbering", "Midterm 1 topics:\n• 2.1 Rates of Change\n• Chapter 3 (sections 3.3 to 3.11)\n• Section 4.5 and 8.4", null, "", []],
    ["ödev duyurulacak", "Ödev yarın duyurulacak.", POSTED_MON, "", []],
    ["bugünkü sınav (Türkçe harf sınırı)", "Bugünkü quiz iptal edildi.", POSTED_MON, "", [["2026-11-02", null, "quiz"]]],
  ]
  for (const [n, t, p, ti, exp] of CASES) check("tarih: " + n, simple(t, p, ti), exp)

  // ders adları
  check("kısa ad IE306", A.shortCourse("2026/2027-1 IE  306.01"), "IE306")
  check("kısa ad MATH101", A.shortCourse("2026/2027-1 MATH101.01"), "MATH101")
  check("kısa ad &amp;", A.shortCourse("2026/2027-1 AD  216.01"), "AD216")

  // ---- uçtan uca: sahte Moodle + bellek içi dosya sistemi
  const files = {}
  A.setFm({ documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b, fileExists: p => p in files || p === "/d/moodle-brief",
    createDirectory() {}, readString: p => files[p], writeString: (p, s) => { files[p] = s } })
  const NOW = Math.floor(FROZEN / 1000)
  let posts = [
    [101, 1, "IE202 Midterm Exam Announcement", "The IE202 Midterm Exam will be held on November 11, from 17:00 to 19:00.", NOW - 50 * 86400],
    [102, 1, "Midterm Date Updated", "The exam date has been updated. The exam will be held on November 17, from 17:00 to 19:00.", NOW - 30 * 86400],
    [201, 2, "Office hours", "Office hours moved to TB215.", NOW - 3600],
    [202, 3, "Office hours", "Office hours moved to TB215.", NOW - 3600],
  ]
  const courses = [
    { id: 1, shortname: "2026/2027-1 IE  202.01", startdate: NOW - 60 * 86400, enddate: NOW + 60 * 86400 },
    { id: 2, shortname: "2026/2027-1 MATH101.01", startdate: NOW - 60 * 86400, enddate: NOW + 60 * 86400 },
    { id: 3, shortname: "2026/2027-1 MATH101.02", startdate: NOW - 60 * 86400, enddate: NOW + 60 * 86400 },
  ]
  A.setPost(async (url, body) => {
    const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent)))
    const fn = p.wsfunction
    if (fn === "core_webservice_get_site_info") return { userid: 7, fullname: "Test" }
    if (fn === "core_enrol_get_users_courses") return courses
    if (fn === "core_course_get_contents") return p.courseid === "1" ? [{ id: 9, summary: "", modules: [
      { id: 500, modname: "assign", name: "HW3 &amp; extras", dates: [{ label: "Due:", timestamp: ts(2026, 11, 8, 0, 0) }] },
      { id: 501, modname: "feedback", name: "Survey", dates: [{ label: "Opens:", timestamp: NOW + 86400 }, { label: "Closes:", timestamp: NOW + 2 * 86400 }] }] }] : []
    if (fn === "mod_forum_get_forums_by_courses") return courses.map(c => ({ id: 50 + c.id, course: c.id, type: "news" }))
    if (fn === "mod_forum_get_forum_discussions") {
      const cid = +p.forumid - 50
      return { discussions: posts.filter(x => x[1] === cid).map(([did, c, s, b, cr]) => ({ discussion: did, subject: s, message: b, created: cr, modified: cr, userfullname: "H", numreplies: 0 })) }
    }
    if (fn === "core_calendar_get_calendar_events") return { events: [] }
    if (fn === "core_calendar_get_action_events_by_timesort") return { events: [] }
    if (fn === "message_popup_get_popup_notifications") return { exception: "x", errorcode: "nopermission", message: "disabled" }
    return {}
  })
  let st = A.loadState()
  let data = await A.collect("https://m", "tok", {})
  let fresh = A.ingest(st, data)
  A.saveState(st)
  check("ilk çalıştırmada anlık bildirim yok", fresh.length, 0)
  let m = A.buildModel(st, new Date(FROZEN))
  const ex = m.exams.map(e => [e.course, e.date, e.changed_from || null])
  check("IE202 17 Kas, eskisi 11 Kas", ex, [["IE202", "2026-11-17", "2026-11-11"]])
  check("şube tekrarı tek duyuru", m.other.concat(m.ann).filter(n => n.title === "Office hours").length, 1)
  check("anket açılışı yok, kapanışı var", m.week.map(e => e.title).filter(t => /Survey/.test(t)), ["Survey (kapanış)"])
  check("00:00 teslim → önceki gün 23:59, &amp; çözüldü", m.week.filter(e => /HW3/.test(e.title)).map(e => [e.title, e._t, e._d.getDate()]), [["HW3 & extras", "23:59", 7]])
  const nt = A.notificationText(m)
  check("bildirim metninde sınav ve uyarı", /IE202 Ara sınav.*17 Kas.*tarih değişti/.test(nt), true)
  check("html üretiliyor", A.briefHtml(m).includes("Bu hafta"), true)

  // yeni duyuru gelince anlık bildirim listesine girer; düzenlenince eski sürüm kayıtta kalır
  A.setNow(() => new Date(FROZEN.getTime() + 2 * 3600 * 1000))
  posts.push([103, 1, "Quiz 2", "Quiz 2 on November 20 at 10:00.", NOW + 3600])
  posts[1] = [102, 1, "Midterm Date Updated", "The exam will be held on November 19, from 17:00 to 19:00.", NOW - 30 * 86400]
  data = await A.collect("https://m", "tok", st.replyCache)
  fresh = A.ingest(st, data)
  check("yeni + düzenlenen duyuru anlık listede", fresh.map(f => f.key).sort(), ["disc:102", "disc:103"])
  check("eski sürümün tarihi kayıtta", st.extracted["disc:102"].previous_versions[0].events[0].date, "2026-11-17")
  m = A.buildModel(st, new Date(FROZEN.getTime() + 2 * 3600 * 1000))
  check("yeni tarih geçerli", m.exams.filter(e => e.course === "IE202" && e.type === "midterm").map(e => [e.date, e.changed_from])[0], ["2026-11-19", "2026-11-11"])

  // kaldırılan duyuru: silinmez, 36 saat sonra gizlenir
  posts = posts.filter(p => p[0] !== 103)
  data = await A.collect("https://m", "tok", st.replyCache); A.ingest(st, data)
  check("kaldırılan hemen gizlenmez", Boolean(st.extracted["disc:103"].hidden), false)
  A.setNow(() => new Date(FROZEN.getTime() + 40 * 3600 * 1000))
  data = await A.collect("https://m", "tok", st.replyCache); A.ingest(st, data)
  check("36 saat sonra gizli ama kayıtta", [Boolean(st.extracted["disc:103"]), st.extracted["disc:103"].hidden], [true, true])
  const archLines = files["/d/moodle-brief/archive.jsonl"].trim().split("\n").length
  check("arşiv büyüdü, küçülmedi", archLines >= 7, true)

  // sabah bildirimi zamanı
  A.setNow(() => new Date(2026, 10, 5, 6, 0))
  check("06:00'da → bugün 07:30", A.nextSendDate({ settings: { sendTime: "07:30" } }, new Date(2026, 10, 5, 6, 0)).toString(), new Date(2026, 10, 5, 7, 30).toString())
  check("08:00'da → yarın 07:30", A.nextSendDate({ settings: { sendTime: "07:30" } }, new Date(2026, 10, 5, 8, 0)).toString(), new Date(2026, 10, 6, 7, 30).toString())

  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail ? 1 : 0)
})()
