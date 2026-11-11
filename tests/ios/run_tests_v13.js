// node tests/ios/run_tests_v13.js — v1.3: sınav sonrası oturum sınav sanılmaz, kurallar değişince yeniden tarama,
// görüşme hatırlatması "son" demez, saati geçen işler, kısa sabah bildirimi, anlık bildirim iyileştirmeleri
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
let pass = 0, fail = 0
function check(name, got, exp) {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++
  else { fail++; console.log("✗", name, "\n   got:", JSON.stringify(got), "\n   exp:", JSON.stringify(exp)) }
}
const MORNING = new Date(2026, 10, 11, 7, 30), NOW = Math.floor(MORNING / 1000), DAY = 86400
const ts = (y, mo, d, h = 0, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi) / 1000)
const fmt = d => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`

const scheduled = [], removed = []
global.Notification = class { setTriggerDate(d) { this.at = d } async schedule() { scheduled.push({ id: this.identifier, title: this.title, body: this.body, at: this.at }) }
  static removePending(ids) { removed.push(...ids) } }
global.URLScheme = { forRunningScript: () => "scriptable:///run/x" }
global.ListWidget = class { constructor() { this.t = [] } addText(t) { this.t.push(t); return {} } addSpacer() {} }
global.Color = Object.assign(class {}, { dynamic: () => ({}), gray: () => ({}), black: () => ({}), white: () => ({}) })
global.Font = { boldSystemFont: () => ({}), semiboldSystemFont: () => ({}), systemFont: () => ({}) }
global.config = { widgetFamily: "small" }

// Sınav yapıldıktan sonra gelen gerçek bir duyurunun biçimi (adlar değiştirildi)
const REVIEW_ANN = "<p>Dear Math101 students,</p><p>You can find your midterm grade on the Moodle page. The average is 20.3 out of 40 .</p>" +
  "<p>To see your exam paper, you should book an appointment via the Silent Exam Review Session Scheduler on the course page.</p>" +
  "<p>The silent midterm exam review session will be on Wednesday, November 11th, between 13.00-16.00 at the following places:</p>" +
  "<p>13.00-15.00: EF102</p><p>15.00-16.00: EF116</p><p>You will have 12 minutes to see your paper.</p><p>Best,</p>"

;(async () => {
  const EXP = {}
  await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  const A = EXP.api
  let clock = MORNING.getTime()
  A.setNow(() => new Date(clock))
  const ev = (text, posted = null, title = "") => A.regexDates(text, posted, title).map(e => [e.date, e.time, e.type])

  // ---- sınav sonrası oturumlar sınav değil
  check("kağıt inceleme oturumu ara sınav değil", ev(A.htmlToText(REVIEW_ANN), ts(2026, 11, 10, 14, 5), "Midterm Grades and Review Session Details"),
    [["2026-11-11", "13:00", "review"]])
  check("midterm exam grades", ev("Midterm exam grades will be discussed on November 12."), [["2026-11-12", null, "other"]])
  check("exam paper viewing", ev("Final exam paper viewing is on December 28 at 10:00."), [["2026-12-28", "10:00", "review"]])
  check("sınav kağıdı inceleme", ev("Vize sınav kağıtları 13 Kasım 14:00'te incelenebilir."), [["2026-11-13", "14:00", "other"]])
  check("gerçek ara sınav hâlâ ara sınav", ev("The Midterm Exam will be on Monday, November 16th, at 17.00."), [["2026-11-16", "17:00", "midterm"]])
  check("midterm exam 2 hâlâ ara sınav", ev("Midterm exam 2 is on December 7 at 17:00."), [["2026-12-07", "17:00", "midterm"]])
  check("itiraz oturumu, lab salonunda → lab değil", ev("The objection session for Quiz 1 will be held on Monday, November 16, from 15:00 to 17:00 at the BUFAIM Lab (M2142)."),
    [["2026-11-16", "15:00", "review"]])
  check("oturumun ne olduğu önceki cümlede", ev("The time for tomorrow's exam review and grading objections session has been updated. The session will now take place on November 13, between 09:30 and 11:00 , at Sesdyn Lab (M3230)."),
    [["2026-11-13", "09:30", "review"]])
  check("gerçek lab hâlâ lab", ev("Lab 3 will be held on November 12 at 14:00."), [["2026-11-12", "14:00", "lab"]])
  check("'in the lab on' hâlâ lab", ev("We will meet in the lab on November 12 at 14:00."), [["2026-11-12", "14:00", "lab"]])
  check("lab session hâlâ lab", ev("There will be an extra session at the lab session on November 12."), [["2026-11-12", null, "lab"]])

  // ---- sahte Moodle: 11 Kasım sabahı
  const files = {}
  A.setFm({ documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b, fileExists: p => p in files || p === "/d/moodle-brief",
    createDirectory() {}, readString: p => files[p], writeString: (p, s) => { files[p] = s } })
  const closeC = ts(2026, 11, 11, 8, 31), meet = ts(2026, 11, 11, 13, 0)
  const M = { discussions: [
    { discussion: 900, subject: "Midterm Grades and Review Session Details", message: REVIEW_ANN,
      created: ts(2026, 11, 10, 14, 5), modified: ts(2026, 11, 10, 14, 5), userfullname: "T", numreplies: 0 },
    { discussion: 901, subject: "Midterm 2 Date", message: "Midterm 2 will be held on November 17, from 17:00 to 19:00.",
      created: NOW - 20 * DAY, modified: NOW - 20 * DAY, userfullname: "T", numreplies: 0 }], extraCal: [] }
  A.setPost(async (url, body) => {
    const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent))), fn = p.wsfunction
    if (fn === "core_webservice_get_site_info") return { userid: 7, fullname: "Test" }
    if (fn === "core_enrol_get_users_courses") return [
      { id: 1, shortname: "2026/2027-1 IE  306.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY },
      { id: 2, shortname: "2026/2027-1 MATH101.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY }]
    if (fn === "core_course_get_contents") return p.courseid === "1" ? [{ id: 9, summary: "", modules: [
      { id: 601, modname: "feedback", name: "Self-study Material 2 Responses", dates: [{ label: "Closes:", timestamp: closeC }] }] }] : []
    if (fn === "core_calendar_get_calendar_events") return { events: [
      { id: 5, name: "Self-study Material 2 Responses closes", courseid: 1, timestart: closeC, modulename: "feedback", eventtype: "close" },
      { id: 6, name: "Meeting with your Teacher, T. Teacher", courseid: 2, timestart: meet, modulename: "scheduler", eventtype: "SSstu:1:2",
        description: "<p>Silent Exam Review Session Scheduler</p>" },
      ...M.extraCal] }
    if (fn === "mod_forum_get_forums_by_courses") return [{ id: 77, course: 2, type: "news" }]
    if (fn === "mod_forum_get_forum_discussions") return { discussions: M.discussions }
    return {}
  })

  let st = A.loadState()
  A.ingest(st, await A.collect("https://m", "tok", {}))
  let m = A.buildModel(st, new Date(clock))
  check("bugün: kapanış + görüşme; uydurma 'Ara sınav 13:00' yok", m.todays.map(e => [e._t, e.course, e.title]),
    [["08:31", "IE306", "Self-study Material 2 Responses (kapanış)"], ["13:00", "MATH101", "Meeting with your Teacher, T. Teacher"]])
  check("en yakın sınav: gerçek olan", m.exams.map(e => [e.course, e.type, e.date]), [["MATH101", "midterm", "2026-11-17"]])
  check("sabah bildirimi: saat başta, başlık kısaltılmış, sınav satırı görünür", A.notificationText(m).split("\n").slice(0, 2),
    ["📌 Bugün: 08:31 IE306 Self-study Material 2 R… (kapanış) · 13:00 MATH101 Meeting with your Teacher, T. Tea…",
     "🎯 MATH101 Ara sınav · 17 Kas Sal (6 gün)"])

  // ---- v1.2'den güncelleyen telefon: kayıtta eski kuralların yanlış okuduğu tarih duruyor
  const wrong = [{ title: "x", type: "midterm", date: "2026-11-11", time: "13:00", certainty: "approximate", detail: "metinden" }]
  st.extracted["disc:900"].events = wrong; delete st.rules
  check("eski kayıt: yanlış sınav görünürdü", A.buildModel(st, new Date(clock)).exams[0].date, "2026-11-11")
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  check("güncellemeden sonra ilk yenilemede kayıt düzelir", st.extracted["disc:900"].events.map(e => e.type), ["review"])
  check("düzelince sınav satırı doğru", A.buildModel(st, new Date(clock)).exams[0].date, "2026-11-17")
  check("yeniden tarama öğeyi 'yeni' yapmaz", Object.values(st.firstSeen).filter(f => f.updated).length, 0)
  st.extracted["disc:900"].events = wrong
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  check("kurallar aynıysa her yenilemede yeniden taranmaz", st.extracted["disc:900"].events, wrong)
  delete st.rules
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))

  // ---- hatırlatma: görüşme için "son" denmez; iş adı gövdede tam yazılır
  clock = new Date(2026, 10, 11, 7, 40).getTime()
  m = A.buildModel(st, new Date(clock))
  await A.scheduleReminders(st, m.all)
  check("hatırlatma: görüşme 3 saat önce, 'son' yok; kapanış 'son'", scheduled.map(s => [s.title, s.body, fmt(s.at)]).sort(),
    [["⏰ IE306 · Bugün 08:31 son", "Self-study Material 2 Responses (kapanış)", "11/11 07:41"],
     ["⏰ MATH101 · Bugün 13:00", "Meeting with your Teacher, T. Teacher", "11/11 10:00"]])
  const rk = (title, source, etype, type) => A.remKind({ title, source, etype, type })
  check("tür: takvim görüşmesi", rk("Meeting with your Teacher", "moodle takvim", "SSstu:1:2", "scheduler"), "start")
  check("tür: takvim 'is due'", rk("HW3 is due", "moodle takvim", "due", "assign"), "due")
  check("tür: takvim 'closes' (eski kayıt, etype yok)", rk("Survey closes", "moodle takvim", undefined, "feedback"), "due")
  check("tür: takvim 'opens'", rk("Quiz 3 opens", "moodle takvim", "open", "quiz"), "open")
  check("tür: ödev kaydı", rk("HW3", "moodle ödev", undefined, "ödev teslimi"), "due")
  check("tür: quiz açılış", rk("Quiz 3", "moodle quiz", undefined, "quiz açılış"), "open")
  check("tür: ders etkinliği (Türkçe 'son gün')", rk("Proje için son gün", "moodle takvim", "course", "course"), "due")

  // ---- öğlen: saati geçen iş bildirimde ve widget'ta "sıradaki" diye gösterilmez
  clock = new Date(2026, 10, 11, 12, 20).getTime()
  m = A.buildModel(st, new Date(clock))
  check("08:31 geçti, 13:00 geçmedi", m.todays.map(e => [e._t, e._past]), [["08:31", true], ["13:00", false]])
  check("bildirim: sadece kalan iş", A.notificationText(m).split("\n")[0], "📌 Bugün: 13:00 MATH101 Meeting with your Teacher, T. Tea…")
  check("html: geçen iş işaretli, silinmez", (A.briefHtml(m).match(/\(saati geçti\)/g) || []).length, 1)
  check("küçük widget: sıradaki iş saati geçen değil", A.widget(m, st, null).t.slice(0, 3),
    ["🎓 Moodle", "MATH101 Ara sınav · 6 gün", "bugün: MATH101 Meeting with your Teacher, T. Teacher"])
  clock = new Date(2026, 10, 11, 16, 0).getTime()
  check("bildirim: hepsi geçtiyse", A.notificationText(A.buildModel(st, new Date(clock))).split("\n")[0], "📌 Bugün kalan bir şey yok")

  // ---- takvimdeki "exam review" kaydı sınavlar listesine girmez; 3'ten fazla iş "+N" olur
  clock = MORNING.getTime()
  M.extraCal = [
    { id: 7, name: "Exam 1 review and objections", courseid: 1, timestart: ts(2026, 11, 11, 10, 0), eventtype: "course" },
    { id: 8, name: "Guest lecture", courseid: 1, timestart: ts(2026, 11, 11, 15, 0), eventtype: "course" },
    { id: 9, name: "Quiz 4", courseid: 1, timestart: ts(2026, 11, 12, 9, 0), eventtype: "course" }]
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  m = A.buildModel(st, new Date(clock))
  check("sınavlar: inceleme oturumu yok, gerçek quiz var", m.exams.map(e => e.title.slice(0, 12)), ["Quiz 4", "Midterm 2 wi"])
  check("bildirim: en çok 3 iş + kalan sayı", A.notificationText(m).split("\n")[0].replace(/^.* · /, ""), "+1")

  // ---- anlık bildirimler
  check("selam satırı atılır", A.stripHello("Dear Math101 students,\n You can find your midterm grade."), " You can find your midterm grade.")
  check("selam: Türkçe", A.stripHello("Merhaba arkadaşlar,\n\nYarın ders yok."), "Yarın ders yok.")
  check("selamla başlayan asıl cümle atılmaz", A.stripHello("Dear all, the quiz is postponed.\nSee you."), "Dear all, the quiz is postponed.\nSee you.")
  check("selam değilse dokunulmaz", A.stripHello("History of the course\nx"), "History of the course\nx")
  scheduled.length = 0; st.notifiedInstant = {}
  const mkIt = (i, kind = "duyuru") => ({ key: "disc:" + i, version: "v" + i, kind, course: "IE306", title: "Duyuru " + i,
    text: "Gönderen: T\nTarih: x\n\nDear all,\nMetin " + i })
  st.firstSeen["disc:1"] = { t: NOW, updated: true }; st.extracted["disc:1"] = { change: "+ Room M100" }
  await A.instantNotify(st, [1, 2, 3, 4, 5].map(i => mkIt(i)))
  check("anlık: güncellenen işaretli, selam yok, 3'ten fazlası tek bildirimde", scheduled.map(s => [s.title, s.body]),
    [["📣 Güncellendi: IE306 · Duyuru 1", "✏️ + Room M100\nMetin 1"], ["📣 IE306 · Duyuru 2", "Metin 2"], ["📣 IE306 · Duyuru 3", "Metin 3"],
     ["📬 2 yeni duyuru/not daha", "IE306 · Duyuru 4\nIE306 · Duyuru 5"]])
  scheduled.length = 0
  await A.instantNotify(st, [1, 2, 3, 4, 5].map(i => mkIt(i)))
  check("anlık: aynı öğe ikinci kez bildirilmez", scheduled.length, 0)

  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error("ÇALIŞMA HATASI:", e); process.exit(1) })
