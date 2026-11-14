// node tests/ios/run_tests_v16.js — v1.6: gerçek bir dönemin arşivi brifingden geçirilerek bulunan hatalar.
// Her test, daha önce yanlış olan bir durumdur: sahte "güncellendi", sahte sınav, sessizce birleştirilip kaybolan
// tarih, "Moodle'dan kalktı" sanılan eski duyuru.
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
let pass = 0, fail = 0
function check(name, got, exp) {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++
  else { fail++; console.log("✗", name, "\n   got:", JSON.stringify(got), "\n   exp:", JSON.stringify(exp)) }
}
const T0 = new Date(2026, 10, 5, 10, 0), NOW = Math.floor(T0 / 1000), DAY = 86400      // Perşembe 5 Kas 2026 10:00
const ts = (y, mo, d, h = 0, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi) / 1000)
global.Notification = class { setTriggerDate() {} async schedule() {} static removePending() {} }
global.URLScheme = { forRunningScript: () => "scriptable:///run/x" }

;(async () => {
  const EXP = {}
  await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  const A = EXP.api
  let clock = T0.getTime()
  A.setNow(() => new Date(clock))
  let files = {}
  A.setFm({ documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b, fileExists: p => p in files || p === "/d/moodle-brief",
    createDirectory() {}, readString: p => files[p], writeString: (p, s) => { files[p] = s } })
  const strip = h => h.replace(/<style[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

  // ---- metinden tarih: tuzaklar
  const dates = t => A.regexDates(t, NOW, "").map(e => [e.type, e.date, e.time])
  check("'may' fiili Mayıs değil", [dates("Quiz 2 may be postponed, we will let you know."), dates("Students in section 3 may take the quiz in room M1100.")], [[], []])
  check("gerçek Mayıs tarihi çalışır", dates("The final exam is on 12 May at 10:00."), [["final", "2027-05-12", "10:00"]])
  check("Türkçe mayıs çalışır", dates("Ödev 3 Mayıs tarihine kadar teslim edilmelidir."), [["assignment", "2027-05-03", null]])
  check("'Finally' final değil", dates("Finally, please note that on November 24 there is no class."), [["other", "2026-11-24", null]])
  check("'examine' sınav değil", dates("We will examine the reports on November 25."), [["other", "2026-11-25", null]])
  check("'For example' sınavı gizlemez", dates("For example, the quiz on November 20 covers chapter 5."), [["quiz", "2026-11-20", null]])
  check("'due to' teslim değil", dates("There will be no class on November 26 due to the holiday."), [["other", "2026-11-26", null]])
  check("'due' hâlâ teslim", dates("The report is due November 26."), [["assignment", "2026-11-26", null]])
  check("'at 9.12' saattir", dates("The quiz will start at 9.12 in M1100."), [])
  check("'on 9.12' tarihtir", dates("Quiz 3 is on 9.12 in M1100."), [["quiz", "2026-12-09", null]])
  check("'final examination' çalışır", dates("The final examination is on November 30 at 09:00."), [["final", "2026-11-30", "09:00"]])

  // ---- adında sınav kelimesi geçen teslimler sınav değil
  check("sınav mı", [A.isExam({ type: "assign", title: "Midterm Project Report" }), A.isExam({ type: "ödev teslimi", title: "Final Project Submission" }),
    A.isExam({ type: "feedback", title: "Example Sheet 3 (kapanış)" }), A.isExam({ type: "course", title: "Finally: group lists" }),
    A.isExam({ type: "course", title: "Midterm" }), A.isExam({ type: "quiz kapanış", title: "Quiz 3 (kapanış)" }),
    A.isExam({ type: "class_change", title: "The midterm is postponed to November 20" })],
    [false, false, false, false, true, true, true])

  // ---- her hafta duyurulan numarasız quiz tarih değişikliği değil
  const sup = (typ, oldDate, oldPosted, newDate, newPosted) => A.supersede([
    { course: "IE202", type: typ, title: typ, date: oldDate, posted: oldPosted },
    { course: "IE202", type: typ, title: typ, date: newDate, posted: newPosted }])
  const weekly = sup("quiz", "2026-11-02", ts(2026, 10, 29), "2026-11-09", ts(2026, 11, 4))
  check("haftalık quiz: uyarı yok", [weekly.map(e => e.date), weekly[0].changed_from], [["2026-11-09"], undefined])
  check("ertelenen quiz: uyarı var", sup("quiz", "2026-11-09", ts(2026, 11, 2), "2026-11-12", ts(2026, 11, 4))[0].changed_from, "2026-11-09")
  check("ara sınav: eski davranış", sup("midterm", "2026-11-01", NOW - 60 * DAY, "2026-11-17", NOW - 2 * DAY)[0].changed_from, "2026-11-01")

  // ---- metindeki tarihi Moodle'ın kendi kaydıyla birleştirme
  const exact = (course, title, type, y, mo, d, h = 23, mi = 59) => {
    const dt = new Date(y, mo - 1, d, h, mi), p = n => String(n).padStart(2, "0")
    return { course, title, type, date: `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`, time: `${p(h)}:${p(mi)}`, certainty: "exact", source: "moodle ödev" }
  }
  const doc = (course, type, date, title, item = "disc:1", source = "Announcement", time = null) =>
    ({ course, type, date, time, title, certainty: "approximate", item, source, posted: NOW - DAY })
  let evs = A.mergedEvents([exact("IE202", "Homework 5", "ödev teslimi", 2026, 11, 9)],
    [doc("IE202", "review", "2026-11-09", "The objection session for Quiz 2 will be held on Monday", "disc:1", "x", "15:00"),
     doc("IE202", "assignment", "2026-11-09", "Homework 5 is due on Monday", "disc:2")], T0)
  check("teslim günündeki itiraz oturumu kaybolmaz", evs.map(e => [e.type, e._t]), [["review", "15:00"], ["ödev teslimi", "23:59"]])
  evs = A.mergedEvents([{ ...exact("MATH101", "Meeting with your Teacher", "scheduler", 2026, 11, 9, 13, 0), source: "moodle takvim" }],
    [doc("MATH101", "review", "2026-11-09", "The silent exam review session will be on Monday", "disc:1", "x", "13:00")], T0)
  check("aynı saatteki randevu = o oturum (tek satır)", evs.map(e => e.type), ["scheduler"])
  evs = A.mergedEvents([], [doc("IE202", "review", "2026-11-09", "The objection session will be held on Monday", "disc:1", "x", "15:00"),
    doc("IE202", "review", "2026-11-09", "Reminder: objection session on November 9", "disc:2")], T0)
  check("aynı oturumun iki duyurusu tek satır", evs.length, 1)

  const mk = "2nd Exercise MakeUp due November 9, by 23.59"
  const own = [["assign:66858", mk], ["mod:1134416", mk], ["cal:29214936", mk + " is due"]].map(([k, s]) =>
    doc("AD216", "assignment", "2026-11-08", "The assignment is due November 8 by 23.59", k, s, "23:59"))
  evs = A.mergedEvents([exact("AD216", mk, "ödev teslimi", 2026, 11, 9)], own, T0)
  check("açıklamadaki tarih çelişkisi: tek satır + uyarı", [evs.length, evs[0].text_dates], [1, ["2026-11-08"]])
  let st = A.loadState()
  st.lastStruct = [exact("AD216", mk, "ödev teslimi", 2026, 11, 9)]
  st.extracted = { "assign:66858": { course: "AD216", title: mk, kind: "ödev", posted: NOW - DAY, events: [{ type: "assignment", date: "2026-11-08", time: "23:59", title: "The assignment is due November 8 by 23.59", certainty: "approximate" }] } }
  let text = strip(A.briefHtml(A.buildModel(st, T0)))
  check("html: çelişki uyarısı", [text.includes("açıklamasında 8 Kas yazıyor, Moodle'da 9 Kas — kontrol et"), (text.match(/AD216/g) || []).length], [true, 1])
  evs = A.mergedEvents([exact("AD216", "Homework 5", "ödev teslimi", 2026, 11, 10, 0, 0)],
    [doc("AD216", "assignment", "2026-11-09", "Due November 9 by 23.59", "assign:5", "Homework 5")], T0)
  check("00:00 teslim = önceki gün: çelişki değil, tekrar", [evs.length, evs[0].text_dates], [1, undefined])
  evs = A.mergedEvents([exact("AD216", "Term Project", "ödev teslimi", 2026, 11, 25)],
    [doc("AD216", "assignment", "2026-11-07", "The draft is due November 7", "assign:9", "Term Project")], T0)
  check("uzak tarih ayrı bir aşamadır", [evs.map(e => e.date), evs[1].text_dates], [["2026-11-07", "2026-11-25"], undefined])
  evs = A.mergedEvents([], [doc("IE202", "midterm", "2026-11-17", "The exam will be held on November 17", "disc:1", "x", "17:00"),
    doc("Bildirim", "midterm", "2026-11-17", "posted in IE 202.01: Midterm on November 17", "notif:7")], T0)
  check("bildirimdeki tarih dersin olayını tekrarlamaz", evs.map(e => e.course), ["IE202"])
  check("başka kaynağı olmayan bildirim tarihi kalır", A.mergedEvents([], [doc("Bildirim", "midterm", "2026-11-17", "Midterm on November 17", "notif:7")], T0).length, 1)

  // ---- tek cümle: giriş atılır, boşluklar toplanır, asıl bilgi sığar
  const g = A.gist("Gönderen: T\nTarih: x\n\nDear Students,\n Please note that starting next week, all Tuesday lectures for Sections 01 and 02 " +
    "will take place in classroom ET01 , located in the ETA-B Block (Educational Technologies Building) on North Campus .\n Your schedule is unchanged.")
  check("tek cümle: asıl bilgi (sınıf) görünür", [g.startsWith("Starting next week, all Tuesday lectures"), g.includes("classroom ET01, located"), g.length <= 120], [true, true, true])
  check("tek cümle: hatırlatma girişi", A.gist("This is a reminder that the lab starts at 9 ."), "The lab starts at 9.")
  check("tek cümle: girişten sonra bir şey kalmıyorsa dokunma", A.gist("Note that."), "Note that.")

  // ---- sahte Moodle
  const M = { posts: [], modules: [], notifs: [], forum: null }
  A.setPost(async (url, body) => {
    const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent))), fn = p.wsfunction
    if (fn === "core_webservice_get_site_info") return { userid: 7, fullname: "Test" }
    if (fn === "core_enrol_get_users_courses") return [{ id: 1, shortname: "2026/2027-1 IE  306.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY }]
    if (fn === "core_course_get_contents") return [{ id: 9, summary: "", modules: M.modules }]
    if (fn === "mod_forum_get_forums_by_courses") return [{ id: 77, course: 1, type: "news" }]
    if (fn === "mod_forum_get_forum_discussions") return M.forum ? M.forum(+p.page, +p.perpage) : { discussions: +p.page === 0 ? M.posts : [] }
    if (fn === "mod_forum_get_discussion_posts") return { posts: [{ id: 1, parentid: 0, message: "first" }, { id: 5001, parentid: 1, message: "Rooms: M100 and M1170.", timecreated: NOW + 3000, author: { fullname: "TA" } }] }
    if (fn === "message_popup_get_popup_notifications") return { notifications: M.notifs }
    if (fn === "gradereport_user_get_grade_items") return { usergrades: [{ gradeitems: [] }] }
    return {}
  })
  const run = async s => A.ingest(s, await A.collect("https://m", "tok", s.replyCache))
  const fresh0 = () => { files = {}; clock = T0.getTime(); M.posts = []; M.modules = []; M.notifs = []; M.forum = null; return A.loadState() }
  const post = (id, subject, message, created, modified, replies = 0) => ({ discussion: id, id: id * 10, subject, message, created, modified: modified || created, userfullname: "T", numreplies: replies })

  // ---- teslim saati geçince etiket "Closes:" -> "Closed:" olur: güncelleme değil
  st = fresh0()
  const survey = { id: 720, modname: "feedback", name: "Self-study Material 2 Responses", dates: [{ label: "Closes:", timestamp: NOW + 3600 }] }
  M.modules = [survey]
  await run(st)
  clock += 2 * 3600 * 1000
  survey.dates = [{ label: "Closed:", timestamp: NOW + 3600 }]
  await run(st)
  let m = A.buildModel(st, new Date(clock))
  check("etiket değişimi: haber değil", [m.other.filter(n => n.updated).length, st.firstSeen["mod:720"].updated], [0, false])
  check("etiket değişimi: yeni sürüm kayda ve arşive geçti", [st.extracted["mod:720"].text, files["/d/moodle-brief/archive.jsonl"].split("\n").filter(l => l.includes("mod:720")).length],
    ["Closed:: 2026-11-05 11:00 Perşembe", 2])
  clock += DAY * 1000
  survey.dates = [{ label: "Closed:", timestamp: NOW + 3 * DAY }]
  await run(st)
  m = A.buildModel(st, new Date(clock))
  check("gerçek tarih değişimi: haber", m.other.filter(n => n.updated).map(n => n.change), ["Closed:: 2026-11-08 10:00 Pazar"])

  // ---- cevap gelince tartışmanın "değişti" zamanı ilerler: duyuru güncellenmedi, cevap yeni
  st = fresh0()
  M.posts = [post(101, "Midterm", "The IE306 midterm will be held on November 17 at 17:00.", NOW - 2 * DAY)]
  await run(st)
  clock += 3600 * 1000
  M.posts = [post(101, "Midterm", "The IE306 midterm will be held on November 17 at 17:00.", NOW - 2 * DAY, NOW + 3000, 1)]
  let fresh = await run(st)
  m = A.buildModel(st, new Date(clock))
  check("cevap: duyuru 'güncellendi' olmaz, cevap haber olur", [fresh.map(f => f.key), m.ann.map(a => [a.title, a.updated])], [["reply:5001"], [["Re: Midterm", false]]])
  clock += 3600 * 1000
  M.posts = [post(101, "Midterm", "The IE306 midterm will be held on November 19 at 17:00.", NOW - 2 * DAY, NOW + 7000, 1)]
  fresh = await run(st)
  check("gerçek düzenleme: güncellendi", [fresh.map(f => f.key), st.firstSeen["disc:101"].updated], [["disc:101"], true])

  // ---- Moodle Türkçe iken etiketler farklıdır: dilden bağımsız kimlik kullanılır
  st = fresh0()
  M.modules = [{ id: 730, modname: "assign", name: "Ödev 3", dates: [
      { label: "Açıldı:", timestamp: NOW + DAY, dataid: "allowsubmissionsfromdate" }, { label: "Son teslim tarihi:", timestamp: NOW + 2 * DAY, dataid: "duedate" }] },
    { id: 731, modname: "feedback", name: "Anket", dates: [{ label: "Kapanıyor:", timestamp: NOW + 3 * DAY, dataid: "timeclose" }] }]
  await run(st)
  check("Türkçe Moodle: teslim yalın, açılış yok, kapanış etiketli", st.lastStruct.map(e => e.title).sort(), ["Anket (kapanış)", "Ödev 3"])

  // ---- 40'tan fazla duyurusu olan forum: ilk sayfanın dışındaki duyuru da okunur, gizlenmez
  const paged = (n, removed = []) => (page, per) => {
    const ids = []
    for (let i = n; i >= 1; i--) if (!removed.includes(i)) ids.push(i)
    return { discussions: ids.slice(page * per, (page + 1) * per).map(i =>
      post(1000 + i, "Announcement " + i, i === 1 ? "The final exam is on December 10 at 10:00." : `Note ${i}.`, NOW - (n - i + 1) * 3600)) }
  }
  st = fresh0()
  M.forum = paged(45)
  for (let i = 0; i < 4; i++) { await run(st); clock += DAY * 1000 }
  check("45 duyuru: hepsi okundu, en eskisi gizlenmedi", [Object.keys(st.extracted).filter(k => k.startsWith("disc:")).length, Boolean(st.extracted["disc:1001"].hidden)], [45, false])
  check("45 duyuru: final tarihi görünüyor", A.buildModel(st, new Date(clock)).exams.map(e => [e.type, e.date]), [["final", "2026-12-10"]])
  M.forum = paged(45, [1])
  for (let i = 0; i < 3; i++) { await run(st); clock += DAY * 1000 }
  check("sonraki sayfadaki duyuru gerçekten silinirse gizlenir", [st.extracted["disc:1001"].hidden, A.buildModel(st, new Date(clock)).exams.length], [true, 0])
  st = fresh0()
  M.forum = paged(200)
  await run(st)
  M.forum = paged(201)                               // 5 sayfa dolu: forumun sonu görülemedi
  for (let i = 0; i < 4; i++) { clock += DAY * 1000; await run(st) }
  check("sonu okunamayan forumda hiçbir duyuru gizlenmez", Boolean(st.extracted["disc:1001"].hidden), false)

  // ---- sürüm dosyası
  const vj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "docs", "version.json"), "utf8"))
  check("version.json betikle aynı sürümde", [vj.version, A.VERSION], ["1.6.0", "1.6.0"])

  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error("ÇALIŞMA HATASI:", e); process.exit(1) })
