// node tests/ios/run_tests_v15.js — v1.5: özet kısaldı (boş bölüm yok, duyuruda kritik bilgi, eskimiş haber yok,
// ders başına tek satır) + sürüm kontrolü inceleme düzeltmeleri
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
let pass = 0, fail = 0
function check(name, got, exp) {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++
  else { fail++; console.log("✗", name, "\n   got:", JSON.stringify(got), "\n   exp:", JSON.stringify(exp)) }
}
const T0 = new Date(2026, 10, 11, 7, 30), NOW = Math.floor(T0 / 1000), DAY = 86400
const ts = (y, mo, d, h = 0, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi) / 1000)
const fmt = d => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
const scheduled = []
global.Notification = class { setTriggerDate(d) { this.at = d } async schedule() { scheduled.push({ id: this.identifier, title: this.title, body: this.body, at: this.at }) }
  static removePending() {} }
global.URLScheme = { forRunningScript: () => "scriptable:///run/x" }

;(async () => {
  const EXP = {}
  await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  const A = EXP.api
  let clock = T0.getTime()
  A.setNow(() => new Date(clock))
  const files = {}
  A.setFm({ documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b, fileExists: p => p in files || p === "/d/moodle-brief",
    createDirectory() {}, readString: p => files[p], writeString: (p, s) => { files[p] = s } })

  // ---- birim: kritik bilgi, eskimiş haber, tek cümle
  const past = [{ type: "midterm", date: "2026-10-16", time: "17:00", title: "x" }]
  const future = [{ type: "midterm", date: "2026-11-17", time: "17:00", title: "x" }]
  check("bilgi: bugün / yarın / tarih, geçmiş yok, sıralı", A.annFacts([
    { type: "quiz", date: "2026-11-12", time: "09:00", title: "q" }, { type: "midterm", date: "2026-11-11", time: "14:00", title: "m" },
    { type: "final", date: "2026-10-01", time: null, title: "f" }, { type: "assignment", date: "2026-11-20", time: "00:00", title: "a" },
    { type: "other", date: "2026-11-13", time: null, title: "PS8: Friday, November 13th, 15-17, at NH105" }], T0, 9),
    ["Ara sınav bugün 14:00", "Quiz yarın 09:00", "PS8: Friday, November 13th, 15-17, at NH105", "Ödev 19 Kas Per 23:59"])
  check("bilgi: bozuk kayıt çökmez", A.annFacts([null, {}, { date: "x" }], T0), [])
  const old = NOW - 20 * DAY, recent = NOW - 2 * DAY
  check("eskimiş: eski duyuru, tarihi geçmiş", A.isStale({ kind: "duyuru", posted: old, events: past }, T0), true)
  check("eskimiş: eski bildirim", A.isStale({ kind: "bildirim", posted: old, events: [] }, T0), true)
  check("eskimiş değil: yeni", A.isStale({ kind: "duyuru", posted: recent, events: past }, T0), false)
  check("eskimiş değil: tarihi ileride", A.isStale({ kind: "duyuru", posted: old, events: future }, T0), false)
  check("eskimiş değil: metni gerçekten değişmiş", A.isStale({ kind: "duyuru", posted: old, events: [], updated: true, change: "+ Room M100" }, T0), false)
  check("eskimiş değil: not ve dosya", [A.isStale({ kind: "not", posted: old }, T0), A.isStale({ kind: "dosya", posted: old }, T0)], [false, false])
  check("eskimiş değil: tarihi bilinmiyor", A.isStale({ kind: "duyuru", posted: 0, events: [] }, T0), false)
  check("tek cümle: selam atlanır, ilk cümle", A.gist("Gönderen: T\nTarih: x\n\nHello,\nOffice hours moved to TB215. See you there."), "Office hours moved to TB215.")
  check("tek cümle: uzun cümle kısalır", A.gist("A".repeat(200)).length, 120)

  check("başlığı tekrar eden cümle yazılmaz", [A.addsToTitle("The Class & Seating Plan for MT2 has been uploaded to Moodle.", "Class & Seating Plan for MT2"),
    A.addsToTitle("Office hours moved to TB215.", "Office hours"), A.addsToTitle("Yarınki ders iptal edildi.", "Ders hakkında"), A.addsToTitle("", "x")],
    [false, true, true, false])
  check("duyurusu yazılan aynı adlı dosya bir kez", A.filterOther(
    [{ key: "f1", kind: "dosya", course: "IE306", title: "Class & Seating Plan for MT2 / plan.pdf" }, { key: "f2", kind: "dosya", course: "IE306", title: "Lecture 9 / l9.pdf" }],
    [{ key: "d1", kind: "duyuru", course: "IE306", title: "Class & Seating Plan for MT2" }], T0).map(x => x.key), ["f2"])

  // ---- sahte Moodle
  const M = { posts: [], modules: [], cal: [], grades: [] }
  A.setPost(async (url, body) => {
    const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent))), fn = p.wsfunction
    if (fn === "core_webservice_get_site_info") return { userid: 7, fullname: "Test" }
    if (fn === "core_enrol_get_users_courses") return [{ id: 1, shortname: "2026/2027-1 IE  306.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY }]
    if (fn === "core_course_get_contents") return [{ id: 9, summary: "", modules: M.modules }]
    if (fn === "core_calendar_get_calendar_events") return { events: M.cal }
    if (fn === "mod_forum_get_forums_by_courses") return [{ id: 77, course: 1, type: "news" }]
    if (fn === "mod_forum_get_forum_discussions") return { discussions: M.posts }
    if (fn === "message_popup_get_popup_notifications") return { notifications: M.notifs || [] }
    if (fn === "gradereport_user_get_grade_items") return { usergrades: [{ gradeitems: M.grades }] }
    return {}
  })
  const post = (id, subject, message, created, modified) => ({ discussion: id, subject, message, created, modified: modified || created, userfullname: "T", numreplies: 0 })
  const strip = h => h.replace(/<style[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

  // ---- hiçbir şey yok: boş bölüm de yok
  let st = A.loadState()
  A.ingest(st, await A.collect("https://m", "tok", {}))
  let m = A.buildModel(st, new Date(clock))
  let html = A.briefHtml(m), text = strip(html)
  check("boş: bölüm başlığı ve 'yok' cümleleri yazılmaz", ["Teslim yok", "Kayıtlı sınav yok", "Kayıtlı bir şey yok", "yeni bir şey yok", "Sınavlar", "Bu hafta", "📌", "teyit et"].filter(w => text.includes(w)), [])
  check("boş: tek cümle", text.includes("Bugün için kayıtlı bir şey ve yeni içerik yok."), true)
  check("boş: bildirim tek cümle", A.notificationText(m), "Bugün için kayıtlı bir şey ve yeni içerik yok.")

  // ---- eski bir duyuru Moodle'da "değişti" diye yeniden yüzeye çıkar
  M.posts = [post(500, "Class & Seating Plan for MT1", "The seating plan for MT1 on October 16 is uploaded.", NOW - 26 * DAY)]
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))        // ilk görülüş (eski tarihli)
  clock += 3600 * 1000
  M.posts = [post(500, "Class & Seating Plan for MT1", "The seating plan for MT1 on October 16 is uploaded.", NOW - 26 * DAY, NOW)]
  let fresh = A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  m = A.buildModel(st, new Date(clock))
  check("eski duyuru: özete girmez, anlık bildirim de atılmaz", [m.ann.length, fresh.length], [0, 0])
  check("eski duyuru: kayıt duruyor", Boolean(st.extracted["disc:500"]), true)
  check("eski duyuru: bildirim metninde yok", /Seating/.test(A.notificationText(m)), false)
  // aynı eski duyuruya ileri tarihli bilgi eklenirse yeniden haber olur
  clock += 3600 * 1000
  M.posts = [post(500, "Class & Seating Plan for MT1", "The seating plan is uploaded. Make-up exam: November 20 at 10:00.", NOW - 26 * DAY, NOW + 60)]
  fresh = A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  m = A.buildModel(st, new Date(clock))
  check("eski duyuru + yeni ileri tarih: haber", [m.ann.map(a => a.title), fresh.length], [["Class & Seating Plan for MT1"], 1])

  // ---- yeni duyurular: metin değil kritik bilgi
  clock += 3600 * 1000
  const body = "<p>Dear all,</p><p>The Class & Seating Plan for MT2 has been uploaded to Moodle. Phones are strictly prohibited during the exam " +
    "and you must bring your student ID card with you.</p><p>Quiz 3 will be held on November 12 at 12:00 in M100.</p>"
  M.posts.push(post(501, "Class & Seating Plan for MT2", body, Math.floor(clock / 1000) - 60))
  M.posts.push(post(502, "Office hours", "<p>Hello,</p><p>Office hours moved to TB215. See you there.</p>", Math.floor(clock / 1000) - 60))
  M.notifs = [{ id: 1, subject: "2026/2027-1 IE 306.01: Office hours", smallmessage: "T posted in Announcements", timecreated: Math.floor(clock / 1000) - 50 },
              { id: 2, subject: "Your submission was graded", smallmessage: "x", timecreated: Math.floor(clock / 1000) - 50 }]
  M.modules = [1, 2, 3, 4, 5].map(i => ({ id: 800 + i, modname: "resource", name: "Lecture " + i,
    contents: [{ type: "file", filename: `L${i}.pdf`, filepath: "/", filesize: 1, timemodified: Math.floor(clock / 1000) }] }))
  M.modules.push({ id: 810, modname: "quiz", name: "Quiz 3" })
  M.cal = [{ id: 30, name: "Quiz 3 opens", courseid: 1, timestart: ts(2026, 11, 12, 12, 0), modulename: "quiz", eventtype: "open" },
           { id: 31, name: "Project demo", courseid: 1, timestart: ts(2026, 12, 1, 10, 0), eventtype: "course" }]
  A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  m = A.buildModel(st, new Date(clock))
  html = A.briefHtml(m); text = strip(html)
  check("duyuru: tarihli bilgi var, gövde yok", [text.includes("→ Quiz yarın 12:00"), /Phones are strictly|Dear all|student ID/.test(text)], [true, false])
  check("duyuru: tarih yoksa tek kısa cümle", [text.includes("→ Office hours moved to TB215."), text.includes("See you there")], [true, false])
  check("duyuru: başlık Moodle'a bağlı", html.includes('<a href="https://m/mod/forum/discuss.php?d=501">Class &amp; Seating Plan for MT2</a>'), true)
  check("yeni içerik: ders başına tek satır; takvim/bildirim tekrarı yok",
    A.groupOther(m.other).map(g => g.course + " " + g.text),
    ["IE306 5 dosya (Lecture 1, Lecture 2, Lecture 3, +2) · quiz: Quiz 3 · takvim: Project demo (1 Ara)", "Bildirim Your submission was graded"])
  check("html: eski başlıklar yok", ["Diğer (", "Yeni duyurular (", "Yeni notlar ("].filter(w => text.includes(w)), [])
  const nt = A.notificationText(m).split("\n")
  check("bildirim: duyuru satırında kritik bilgi", nt.find(l => l.startsWith("📣")),
    "📣 IE306 Class & Seating Plan for MT2 → Quiz yarın 12:00 · IE306 Office hours · +1")
  check("bildirim: 'Bugün kayıtlı bir şey yok' yazılmaz", nt.some(l => /kayıtlı bir şey yok|kalan bir şey yok/.test(l)), false)

  // ---- "tarih değişti" uyarısı: tazeyken ya da eski tarih geçmemişken
  const sup = (oldDate, newPosted) => A.supersede([
    { course: "IE202", type: "midterm", title: "midterm", date: oldDate, posted: NOW - 60 * DAY },
    { course: "IE202", type: "midterm", title: "midterm", date: "2026-11-17", posted: newPosted }])[0]
  clock = T0.getTime()
  check("uyarı: eski tarih bugün", sup("2026-11-11", NOW - 30 * DAY).changed_from, "2026-11-11")
  check("uyarı: değişiklik taze", sup("2026-11-01", NOW - 2 * DAY).changed_from, "2026-11-01")
  check("uyarı: eski haber → sadece doğru tarih", [sup("2026-11-01", NOW - 30 * DAY).changed_from, sup("2026-11-01", NOW - 30 * DAY).date], [undefined, "2026-11-17"])

  // ---- not tablosu: Moodle'ın simge etiketi adın parçası değil
  check("not adı: 'Manual item' atılır, kimlik aynı", A.gradesFromTable({ tables: [{ tabledata: [
    { itemname: { class: "item", content: "<span>Manual item</span> Exam 1", id: "row_5_7" }, grade: { content: "31.00" }, range: { content: "0–100" } }] }] })
    .map(g => [g.id, g.itemname]), [["5", "Exam 1"]])

  // ---- sürüm kontrolü: inceleme düzeltmeleri
  const su = A.loadState(); su.settings = { sendTime: "07:30", instantAnnouncements: true, updateCheck: true }
  let calls = 0
  clock = new Date(2026, 10, 11, 15, 0).getTime(); scheduled.length = 0
  // 1) kullanıcı güncelledikten sonra "yeni sürüm var" şeridi kalmamalı
  su.updateReady = { version: A.VERSION, notes: "" }; su.updateCheckedAt = clock - 3600 * 1000
  A.setGet(async () => { calls++; return { version: A.VERSION } })
  check("güncelledikten sonra eski 'yeni sürüm' kaydı hemen düşer (ağa çıkmadan)", [await A.checkUpdate(su), su.updateReady, calls], [null, undefined, 0])
  // 2) ulaşılamazsa 20 saat değil 1 saat sonra yeniden dener
  delete su.updateCheckedAt
  A.setGet(async () => { calls++; throw new Error("offline") })
  await A.checkUpdate(su)
  clock += 30 * 60 * 1000; await A.checkUpdate(su)
  check("hata sonrası 30 dk: denemez", calls, 1)
  clock += 31 * 60 * 1000; await A.checkUpdate(su)
  check("hata sonrası 1 saat: yeniden dener", calls, 2)
  // 3) gece bulunursa bildirim sabah 09:00'a kurulur
  A.setGet(async () => ({ version: "99.0.0" }))
  clock = new Date(2026, 10, 12, 3, 10).getTime(); delete su.updateCheckedAt
  await A.checkUpdate(su)
  check("gece 03:10 → aynı sabah 09:00", scheduled.map(s => fmt(s.at)), ["11/12 09:00"])
  scheduled.length = 0; delete su.updateNotified; delete su.updateCheckedAt
  clock = new Date(2026, 10, 12, 23, 30).getTime()
  await A.checkUpdate(su)
  check("gece 23:30 → ertesi sabah 09:00", scheduled.map(s => fmt(s.at)), ["11/13 09:00"])
  scheduled.length = 0; delete su.updateNotified; delete su.updateCheckedAt
  clock = new Date(2026, 10, 12, 15, 0).getTime()
  await A.checkUpdate(su)
  check("gündüz → hemen", scheduled.map(s => s.at), [undefined])
  // 4) bildirim kurulamazsa "bildirildi" sayılmaz, sonraki sefer yeniden dener
  delete su.updateNotified; delete su.updateCheckedAt
  const Real = global.Notification
  global.Notification = class extends Real { async schedule() { throw new Error("izin yok") } }
  let threw = false
  try { await A.checkUpdate(su) } catch (e) { threw = true }
  global.Notification = Real
  check("bildirim kurulamadı: 'bildirildi' işaretlenmedi", [threw, su.updateNotified], [true, undefined])

  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error("ÇALIŞMA HATASI:", e); process.exit(1) })
