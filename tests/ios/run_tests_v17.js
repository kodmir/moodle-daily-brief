// node tests/ios/run_tests_v17.js — v1.7: sınav yeri, sınıf ortalaması, sınavdan önceki akşam hatırlatması,
// bozuk karakter kodlarında çökmeme, "içerik değişti" bildirimi.
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
let pass = 0, fail = 0
function check(name, got, exp) {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++
  else { fail++; console.log("✗", name, "\n   got:", JSON.stringify(got), "\n   exp:", JSON.stringify(exp)) }
}
const T0 = new Date(2026, 10, 5, 10, 0), NOW = Math.floor(T0 / 1000), DAY = 86400      // Perşembe 5 Kas 2026 10:00
const scheduled = []
global.Notification = class {
  setTriggerDate(d) { this.at = d }
  async schedule() { scheduled.push(this) }
  static removePending() {}
}
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

  // ---- sınav yeri
  const place = t => { const e = A.regexDates(t, NOW, "", "IE202")[0]; return e ? (e.place || null) : "NO EVENT" }
  check("yer: 'in M100 and M1170'", place("The exam will be held on November 17, from 17:00 to 19:00 , in M100 and M1170 ."), "M100, M1170")
  check("yer: 'in room NH 304'", place("Quiz 2 will be held on November 9 in room NH 304."), "NH304")
  check("yer: adlı yer + parantez", place("The objection session is on November 9 at the BUFAIM Lab (M2142)."), "M2142")
  check("yer: başka cümledeki etiket", place("Midterm: November 17 at 17:00.\nRooms: M1100, M1170, M2171 or M2180"), "M1100, M1170, M2171, M2180")
  check("yer: Türkçe etiket", place("Vize 17 Kasım Salı 17:00. Yer: KB301 ve KB302"), "KB301, KB302")
  check("yer: Türkçe harfli kod", place("PS6: Tuesday, November 10th, 17-19, at İB102"), "İB102")
  check("yer: parantez içinde liste", place("Check your assigned classroom (M 1170, M 2171 or M 2180) before the exam on November 17."), "M1170, M2171, M2180")
  check("yer değil: dersin kendi kodu", place("The IE202 midterm is on November 17 in IE202."), null)
  check("yer değil: ay kısaltması", place("We will meet at NOV 17 for the quiz."), null)
  check("yer değil: yıl", place("In 2026 the final exam is on December 20."), null)
  check("yer değil: küçük harfli ders adı", place("Students enrolled in Math101.01 take the midterm on November 17."), null)

  // ---- yer brifingde görünür; Moodle'ın kendi kaydına taşınır; satırda zaten yazıyorsa tekrarlanmaz
  let st = A.loadState()
  st.extracted = { "disc:1": { course: "IE202", title: "Midterm Date Updated", kind: "duyuru", posted: NOW - DAY,
    events: A.regexDates("The exam will be held on November 17, from 17:00 to 19:00 , in M100 and M1170 . Please be on time and do not forget your student ID card.", NOW - DAY, "Midterm Date Updated", "IE202") } }
  let m = A.buildModel(st, T0)
  check("model: sınavın yeri", m.exams.map(e => [e.type, e.date, e.place]), [["midterm", "2026-11-17", "M100, M1170"]])
  check("html: yer satırda", strip(A.briefHtml(m)).includes("· 17 Kas Sal 17:00 (12 gün) · M100, M1170"), true)
  const quiz = { course: "IE202", title: "Quiz 2", type: "quiz kapanış", date: "2026-11-09", time: "13:00", certainty: "exact", source: "moodle quiz" }
  let evs = A.mergedEvents([quiz], [{ course: "IE202", type: "quiz", date: "2026-11-09", time: "12:00", title: "Quiz 2 will be held in M1100", certainty: "approximate", place: "M1100", item: "disc:2", source: "x" }], T0)
  check("yer Moodle kaydına taşınır", [evs.length, evs[0].certainty, evs[0].place], [1, "exact", "M1100"])
  st.extracted = { "disc:1": { course: "IE202", title: "Midterm", kind: "duyuru", posted: NOW - DAY,
    events: A.regexDates("The midterm is on November 6 at 17:00 in M100.", NOW - DAY, "Midterm", "IE202") } }
  m = A.buildModel(st, T0)
  check("bildirim: yarınki sınavda yer bir kez", A.notificationText(m), "🎯 IE202 Ara sınav — The midterm is on November 6 at 17:00 in M100 · 6 Kas Cum (yarın)")

  // ---- sınavdan önceki akşam hatırlatması (duyurudan çıkarılmış sınav için de)
  st.extracted["disc:1"].events = A.regexDates("The exam will be held on November 7, from 17:00 to 19:00, in M100 and M1170. Bring your ID card and a calculator with you.", NOW - DAY, "Midterm", "IE202")
  st.settings = Object.assign({}, st.settings)
  scheduled.length = 0
  await A.scheduleReminders(st, A.buildModel(st, T0).all)
  let ex = scheduled.filter(n => n.identifier.includes(".exam."))
  check("akşam hatırlatması: bir gün önce 20:00", ex.map(n => [n.title, n.body, n.at.getDate(), n.at.getHours()]),
    [["🎯 IE202 Ara sınav · Yarın 17:00", "Yer: M100, M1170 · Duyurudan çıkarıldı, teyit et.", 6, 20]])
  scheduled.length = 0
  await A.scheduleReminders(st, A.buildModel(st, T0).all)
  check("akşam hatırlatması: aynı kimlikle yeniden kurulur (çoğalmaz)", new Set(scheduled.map(n => n.identifier)).size, scheduled.length)
  clock = new Date(2026, 10, 6, 22, 30).getTime()                    // akşam 20:00 kaçtı, telefon şimdi açıldı
  scheduled.length = 0
  st.reminders = {}
  await A.scheduleReminders(st, A.buildModel(st, new Date(clock)).all)
  ex = scheduled.filter(n => n.identifier.includes(".exam."))
  check("akşam kaçırıldıysa hemen", ex.map(n => [n.title, Math.round((n.at.getTime() - clock) / 60000)]), [["🎯 IE202 Ara sınav · Yarın 17:00", 1]])
  clock = new Date(2026, 10, 7, 16, 30).getTime()                    // sınava yarım saat kala: artık hatırlatma yok
  scheduled.length = 0
  st.reminders = {}
  await A.scheduleReminders(st, A.buildModel(st, new Date(clock)).all)
  check("sınava bir saatten az kala kurulmaz", scheduled.filter(n => n.identifier.includes(".exam.")).length, 0)
  st.settings.deadlineReminders = false
  clock = T0.getTime(); scheduled.length = 0
  await A.scheduleReminders(st, A.buildModel(st, T0).all)
  check("ayar kapalıysa kurulmaz", scheduled.length, 0)

  // ---- notlar: sınıf ortalaması ve sıra
  check("not: ortalama + sıra", A.gradeStats({ averageformatted: "21.46", rank: 12, numusers: 85 }), "ort. 21.5 · sıra 12/85")
  check("not: ortalama yoksa boş", [A.gradeStats({ averageformatted: "-" }), A.gradeStats({}), A.gradeStats({ averageformatted: null, rank: "x" })], ["", "", ""])
  check("not: sıra tutarsızsa yazılmaz", A.gradeStats({ averageformatted: "61.20 (85)", rank: 90, numusers: 85 }), "ort. 61.2")

  // ---- sahte Moodle ile uçtan uca
  const M = { posts: [], notifs: [], grades: [] }
  A.setPost(async (url, body) => {
    const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent))), fn = p.wsfunction
    if (fn === "core_webservice_get_site_info") return { userid: 7, fullname: "Test" }
    if (fn === "core_enrol_get_users_courses") return [{ id: 1, shortname: "2026/2027-1 IE  306.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY }]
    if (fn === "core_course_get_contents") return [{ id: 9, summary: "", modules: [] }]
    if (fn === "mod_forum_get_forums_by_courses") return [{ id: 77, course: 1, type: "news" }]
    if (fn === "mod_forum_get_forum_discussions") return { discussions: +p.page === 0 ? M.posts : [] }
    if (fn === "message_popup_get_popup_notifications") return { notifications: M.notifs }
    if (fn === "gradereport_user_get_grade_items") return { usergrades: [{ gradeitems: M.grades }] }
    return {}
  })
  const run = async s => A.ingest(s, await A.collect("https://m", "tok", s.replyCache))
  const fresh0 = () => { files = {}; clock = T0.getTime(); M.posts = []; M.notifs = []; M.grades = []; return A.loadState() }
  const post = (id, subject, message, created) => ({ discussion: id, id: id * 10, subject, message, created, modified: created, userfullname: "T", numreplies: 0 })

  st = fresh0()
  await run(st)
  clock += 3600 * 1000
  M.grades = [{ id: 1, itemname: "Midterm", itemtype: "mod", graderaw: 28, gradeformatted: "28.00", grademax: 40, gradedategraded: NOW, averageformatted: "21.46", rank: 12, numusers: 85 }]
  await run(st)
  m = A.buildModel(st, new Date(clock))
  check("not satırı", [m.grades.map(g => g.text), strip(A.briefHtml(m)).includes("Midterm: 28/40 · ort. 21.5 · sıra 12/85")], [["28/40 · ort. 21.5 · sıra 12/85"], true])
  M.grades[0].averageformatted = "22.90"                             // ortalama sonradan oynadı: yeni not değil
  clock += 30 * 3600 * 1000
  check("ortalamanın değişmesi yeni not sayılmaz", (await run(st)).length, 0)

  // ---- "içerik değişti" bildirimi yazılmaz
  st = fresh0()
  await run(st)
  clock += 3600 * 1000
  M.notifs = [{ id: 9, subject: "2026/2027-1 IE  306.01 SYSTEMS content change", smallmessage: "Grades has been changed", timecreated: NOW },
    { id: 10, subject: "Your booking was confirmed", smallmessage: "Slot 3", timecreated: NOW }]
  await run(st)
  m = A.buildModel(st, new Date(clock))
  check("içerik değişti bildirimi yok, diğeri var", m.other.map(n => n.title), ["Your booking was confirmed"])

  // ---- karakter kodları: geçersiz kod çökertmez, adlı kodlar çözülür
  check("geçersiz sayısal kod olduğu gibi kalır", A.htmlToText("a &#99999999; b &#x110000; c &#xD800; d &#0; e"), "a &#99999999; b &#x110000; c &#xD800; d &#0; e")
  check("geçerli sayısal kodlar", A.htmlToText("&#231;&#x15F;&#39;&#128512;"), "çş'😀")
  check("adlı kodlar", A.htmlToText("&Ccedil;ar&scedil;amba&rsquo;da s&inodot;nav &ndash; 10 &le; x &amp;amp; &bogus; &nbsp;son"), "Çarşamba’da sınav – 10 ≤ x &amp; &bogus; son")
  st = fresh0()
  M.posts = [post(101, "S&#99999999;nav &amp; Quiz", "<p>Quiz 2 is on November 9 at 12:00 in M1100 &#xFFFFFFF; &rsquo;</p>", NOW - DAY)]
  let fresh = await run(st)
  check("bozuk kodlu duyuru okunur", [st.extracted["disc:101"].title, st.extracted["disc:101"].events.map(e => [e.type, e.date, e.place])],
    ["S&#99999999;nav & Quiz", [["quiz", "2026-11-09", "M1100"]]])

  // ---- eski sürümün ham bıraktığı kodlar: güncellemeden sonra "güncellendi" yağmaz
  st = fresh0()
  M.posts = [post(101, "Duyuru", "Hocan&#305;n notu: s&#305;nav 12 Kas&#305;m&rsquo;da.", NOW - 3 * DAY)]
  await run(st)
  const exd = st.extracted["disc:101"]
  exd.text = exd.text.replace("’", "&rsquo;")                        // 1.6'nın kaydettiği hâl
  exd.version = "eski-surum"; st.seen["disc:101"] = "eski-surum"
  clock += DAY * 1000
  fresh = await run(st)
  check("ham kodlu eski kayıt güncelleme sayılmaz", [fresh.length, st.firstSeen["disc:101"].updated, st.extracted["disc:101"].text.includes("Kasım’da")], [0, false, true])

  // ---- ders kodu adın neresinde olursa olsun bulunur
  check("ders kodu", [A.shortCourse("2026/2027-1 IE  306.01"), A.shortCourse("Fall 2026 IE 202 Section 1"), A.shortCourse("PHYS101L.03"), A.shortCourse("Turkish for Foreigners"), A.shortCourse("x".repeat(500)).length <= 24],
    ["IE306", "IE202", "PHYS101L", "Turkish for Foreigners", true])

  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error("ÇALIŞMA HATASI:", e); process.exit(1) })
