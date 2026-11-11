// node test/run_tests_v12.js — v1.2: teslim durumu, hatırlatmalar, sınav kaynağı, not tablosu yedeği, küçük widget
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
let pass = 0, fail = 0
function check(name, got, exp) {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++
  else { fail++; console.log("✗", name, "\n   got:", JSON.stringify(got), "\n   exp:", JSON.stringify(exp)) }
}
const FROZEN = new Date(2026, 10, 10, 12, 0), NOW = Math.floor(FROZEN / 1000), DAY = 86400
const ts = (y, mo, d, h = 0, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi) / 1000)
const fmt = d => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`

// sahte Scriptable küreselleri
const scheduled = [], removed = []
global.Notification = class { setTriggerDate(d) { this.at = d } async schedule() { scheduled.push({ id: this.identifier, title: this.title, body: this.body, at: this.at }) }
  static removePending(ids) { removed.push(...ids) } }
global.URLScheme = { forRunningScript: () => "scriptable:///run/x" }
global.ListWidget = class { constructor() { this.t = [] } addText(t) { this.t.push(t); return {} } addSpacer() {} }
global.Color = Object.assign(class {}, { dynamic: () => ({}), gray: () => ({}), black: () => ({}), white: () => ({}) })
global.Font = { boldSystemFont: () => ({}), semiboldSystemFont: () => ({}), systemFont: () => ({}) }
global.config = { widgetFamily: "small" }

;(async () => {
  const EXP = {}
  await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  const A = EXP.api
  let clock = FROZEN.getTime()
  A.setNow(() => new Date(clock))

  // ---- hatırlatma saati
  check("23:59 teslim → 20:59", fmt(A.reminderTime(new Date(2026, 10, 10, 23, 59))), "11/10 20:59")
  check("00:00 teslim → önceki akşam 21:00", fmt(A.reminderTime(new Date(2026, 10, 11, 0, 0))), "11/10 21:00")
  check("08:31 kapanış → önceki akşam 22:00", fmt(A.reminderTime(new Date(2026, 10, 11, 8, 31))), "11/10 22:00")
  check("02:00 teslim → önceki akşam 22:00", fmt(A.reminderTime(new Date(2026, 10, 11, 2, 0))), "11/10 22:00")
  check("17:00 teslim → 14:00", fmt(A.reminderTime(new Date(2026, 10, 11, 17, 0))), "11/11 14:00")

  // ---- not tablosu ayrıştırma
  const table = { tables: [{ tabledata: [
    { itemname: { class: "level1 category", content: "<span>AD 216</span>", id: "cat_1_7" } },
    { itemname: { class: "level2 item", content: '<a href="#">4th Exercise (Take Home Assignment)</a>', id: "row_901_7" }, grade: { content: "85,00" }, range: { content: "0&ndash;100" }, feedback: { content: "<p>Good</p>" } },
    { itemname: { class: "level2 item", content: "Midterm", id: "row_902_7" }, grade: { content: "-" }, range: { content: "0–100" } },
    { itemname: { class: "level2 item", content: "Quiz 1", id: "row_903_7" }, grade: { content: "7.5" }, range: { content: "0–10" } },
    { itemname: { class: "level1 baggt", content: "Course total", id: "row_999_7" }, grade: { content: "60.00" }, range: { content: "0–100" } },
    [], null,
  ] }] }
  const rows = A.gradesFromTable(table)
  check("tablo: sadece girilmiş notlar, toplam/kategori yok", rows.map(r => [r.id, r.itemname, A.fmtGrade(r)]),
    [["901", "4th Exercise (Take Home Assignment)", "85/100"], ["903", "Quiz 1", "7.5/10"]])
  check("tablo: bozuk girdi çökmez", [A.gradesFromTable(null), A.gradesFromTable({}), A.gradesFromTable({ tables: [{}] })], [[], [], []])

  // ---- sahte Moodle
  const files = {}
  A.setFm({ documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b, fileExists: p => p in files || p === "/d/moodle-brief",
    createDirectory() {}, readString: p => files[p], writeString: (p, s) => { files[p] = s } })
  const dueA = ts(2026, 11, 11, 0, 0), dueB = ts(2026, 11, 11, 17, 0), closeC = ts(2026, 11, 11, 8, 31)
  const M = { submitted: { 51: false, 52: true }, statusCalls: 0, statusFails: false }
  A.setPost(async (url, body) => {
    const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent))), fn = p.wsfunction
    if (fn === "core_webservice_get_site_info") return { userid: 7, fullname: "Test" }
    if (fn === "core_enrol_get_users_courses") return [
      { id: 1, shortname: "2026/2027-1 IE  306.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY },
      { id: 2, shortname: "2026/2027-1 AD  216.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY }]
    if (fn === "core_course_get_contents") return p.courseid === "1" ? [{ id: 9, summary: "", modules: [
      { id: 600, modname: "assign", name: "Self-study Material 3", dates: [{ label: "Due:", timestamp: dueA }] },
      { id: 601, modname: "feedback", name: "Self-study Material 2 Responses", dates: [{ label: "Closes:", timestamp: closeC }] }] }] : []
    if (fn === "mod_assign_get_assignments") return { courses: [
      { id: 1, assignments: [{ id: 51, name: "Self-study Material 3", duedate: dueA, intro: "" }, { id: 53, name: "Old HW", duedate: NOW - 20 * DAY, intro: "" }] },
      { id: 2, assignments: [{ id: 52, name: "5th Exercise", duedate: dueB, intro: "" }] }] }
    if (fn === "mod_assign_get_submission_status") {
      M.statusCalls++
      if (M.statusFails) return { exception: "x", errorcode: "nopermission", message: "no" }
      return { lastattempt: { submission: { status: M.submitted[p.assignid] ? "submitted" : "new" } } }
    }
    if (fn === "core_calendar_get_calendar_events") return { events: [{ id: 5, name: "Self-study Material 3 is due", courseid: 1, timestart: dueA, modulename: "assign" }] }
    if (fn === "mod_forum_get_forums_by_courses") return [{ id: 77, course: 1, type: "news" }]
    if (fn === "mod_forum_get_forum_discussions") return { discussions: [{ discussion: 900, subject: "Midterm Date Updated",
      message: "The exam date has been updated. The exam will be held on November 17, from 17:00 to 19:00, in M100 and M1170.",
      created: NOW - 30 * DAY, modified: NOW - 30 * DAY, userfullname: "H", numreplies: 0 }] }
    if (fn === "gradereport_user_get_grade_items") {
      if (p.courseid === "2") return { exception: "x", errorcode: "invalidresponse", message: "Invalid response value detected" }
      return { usergrades: [{ gradeitems: [{ id: 800, itemname: "Exam 1", itemtype: "mod", graderaw: 70, gradeformatted: "70.00", grademax: 100 }] }] }
    }
    if (fn === "gradereport_user_get_grades_table") return table
    return {}
  })

  let st = A.loadState()
  A.ingest(st, await A.collect("https://m", "tok", {}))
  check("teslim durumu sadece yaklaşan ödevler için soruldu", M.statusCalls, 2)
  check("not: bir derste rapor bozuk → tablodan okundu, diğeri normal",
    Object.entries(st.extracted).filter(([k]) => k.startsWith("grade:")).map(([k, e]) => [k, e.course, e.text.split("\n")[0]]).sort(),
    [["grade:1:800", "IE306", "70/100"], ["grade:2:901", "AD216", "85/100"], ["grade:2:903", "AD216", "7.5/10"]])
  let m = A.buildModel(st, new Date(clock))
  check("bugün: 00:00 teslim → bugün 23:59, tek kayıt, teslim edilmemiş", m.todays.map(e => [e.course, e.title, e._t, Boolean(e.done)]), [["IE306", "Self-study Material 3", "23:59", false]])
  check("yarın: teslim edilmiş ödev işaretli", m.week.filter(e => e.title === "5th Exercise").map(e => [e._t, e.done]), [["17:00", true]])
  const html = A.briefHtml(m)
  check("html: ✓ teslim edildi tek yerde", (html.match(/✓ teslim edildi/g) || []).length, 1)
  check("html: sınavın kaynak cümlesi (salon) görünür", /class=q>“The exam will be held on November 17, from 17:00 to 19:00, in M100 and M1170”/.test(html), true)
  check("html: duyuru linki", html.includes('href="https://m/mod/forum/discuss.php?d=900">duyuru ›'), true)
  check("bildirim metni: teslim edilen haftalık sayıya girmez", /Bu hafta 1 teslim/.test(A.notificationText(m)), true)

  // ---- hatırlatmalar
  await A.scheduleReminders(st, m.all)
  check("hatırlatma: teslim edilmemiş ödev (21:00) ve kapanış (22:00); teslim edilen ve sınav yok",
    scheduled.map(s => [s.title, s.body, fmt(s.at)]).sort(),
    [["⏰ IE306 · Bugün 23:59 son", "Self-study Material 3", "11/10 21:00"],
     ["⏰ IE306 · Yarın 08:31 son", "Self-study Material 2 Responses (kapanış)", "11/10 22:00"]])
  // aynı gün tekrar çalışınca aynı kimlikle yeniden planlanır (çift bildirim olmaz)
  const ids1 = scheduled.map(s => s.id).sort(); scheduled.length = 0
  await A.scheduleReminders(st, A.buildModel(st, new Date(clock)).all)
  check("hatırlatma: kimlikler sabit", scheduled.map(s => s.id).sort(), ids1)
  // 21:30: ödev hatırlatması çaldı → tekrar planlanmaz
  clock = new Date(2026, 10, 10, 21, 30).getTime(); scheduled.length = 0
  await A.scheduleReminders(st, A.buildModel(st, new Date(clock)).all)
  check("hatırlatma: çalan tekrar planlanmaz", scheduled.map(s => s.body), ["Self-study Material 2 Responses (kapanış)"])
  // öğrenci ödevi teslim etti → bekleyen hatırlatma iptal
  clock = FROZEN.getTime(); st.reminders = {}; scheduled.length = 0
  await A.scheduleReminders(st, A.buildModel(st, new Date(clock)).all)
  M.submitted[51] = true
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  scheduled.length = 0; removed.length = 0
  m = A.buildModel(st, new Date(clock))
  await A.scheduleReminders(st, m.all)
  check("hatırlatma: teslim edilince iptal", [removed.length, scheduled.map(s => s.body)], [1, ["Self-study Material 2 Responses (kapanış)"]])
  check("bildirim metni: bugünkü teslimler tamam", A.notificationText(m).split("\n")[0], "📌 Bugünkü teslimler tamam ✓")
  // kapatılınca hepsi iptal
  st.settings.deadlineReminders = false; removed.length = 0; scheduled.length = 0
  await A.scheduleReminders(st, m.all)
  check("hatırlatma: ayardan kapatılınca iptal", [removed.length, scheduled.length], [1, 0])
  st.settings.deadlineReminders = true
  // pencerenin içinde öğrenildiyse hemen (1 dk sonra)
  clock = new Date(2026, 10, 11, 15, 0).getTime(); st.reminders = {}; scheduled.length = 0; M.submitted[52] = false
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  await A.scheduleReminders(st, A.buildModel(st, new Date(clock)).all)
  check("hatırlatma: 3 saatten az kaldıysa hemen", scheduled.map(s => [s.title, fmt(s.at), s.body]), [["⏰ AD216 · Bugün 17:00 son", "11/11 15:01", "5th Exercise"]])

  // ---- teslim durumu API'si kapalıysa: çökmez, uyarı üretmez, hatırlatma yine çalışır
  M.statusFails = true; A.WARNINGS.length = 0
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  check("durum API'si kapalı: uyarı yok, done yok", [A.WARNINGS.filter(w => /submission_status/.test(w)).length,
    A.buildModel(st, new Date(clock)).all.filter(e => e.done).length], [0, 0])

  // ---- küçük widget
  clock = FROZEN.getTime(); M.statusFails = false; M.submitted[51] = false
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  const w = A.widget(A.buildModel(st, new Date(clock)), st, null)
  check("küçük widget: sınav + sıradaki teslim", w.t.slice(0, 3), ["🎓 Moodle", "IE306 Ara sınav · 7 gün", "bugün: IE306 Self-study Material 3"])

  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error("ÇALIŞMA HATASI:", e); process.exit(1) })
