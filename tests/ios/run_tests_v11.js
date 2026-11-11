// node test/run_tests_v11.js — v1.1: notlar, tekrar birleştirme, "ne değişti", 1.0.0'dan yükseltme
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
let pass = 0, fail = 0
function check(name, got, exp) {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++
  else { fail++; console.log("✗", name, "\n   got:", JSON.stringify(got), "\n   exp:", JSON.stringify(exp)) }
}
const FROZEN = new Date(2026, 10, 10, 12, 0), NOW = Math.floor(FROZEN / 1000), DAY = 86400
;(async () => {
  const EXP = {}
  await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  const A = EXP.api
  let clock = FROZEN.getTime()
  A.setNow(() => new Date(clock))

  check("diff: satır değişti", A.diffSummary("PS6: Monday (cancelled)\nThu 15-17", "PS7: Monday (cancelled)\nThu 15-17"), "PS7: Monday (cancelled)")
  check("diff: satır uzadı", A.diffSummary("(ENG) R1 R2 R3 R4 R5 R6 R7\n(TUR) R1 R2 R3 R4 R5 R6 R7", "(ENG) R1 R2 R3 R4 R5 R6 R7 R8\n(TUR) R1 R2 R3 R4 R5 R6 R7 R8"), "+ R8")
  check("diff: aynı", A.diffSummary("x y z uzun satır", "x y z uzun satır"), "")
  check("diff: eski yok", A.diffSummary(undefined, "x"), "")
  check("not: 85/100", A.fmtGrade({ gradeformatted: "85.00", graderaw: 85, grademax: 100 }), "85/100")
  check("not: 8,50/10", A.fmtGrade({ gradeformatted: "8,50", graderaw: 8.5, grademax: 10 }), "8.5/10")
  check("not: harf", A.fmtGrade({ gradeformatted: "BA", graderaw: 3.5, grademax: 4 }), "BA")
  check("tür adı", [A.kindTr("etkinlik (label)"), A.kindTr("etkinlik (resource)"), A.kindTr("etkinlik (wiki)"), A.kindTr("dosya")], ["sayfa metni", "dosya", "wiki", "dosya"])

  // ---- sahte Moodle
  const files = {}
  A.setFm({ documentsDirectory: () => "/d", joinPath: (a, b) => a + "/" + b, fileExists: p => p in files || p === "/d/moodle-brief",
    createDirectory() {}, readString: p => files[p], writeString: (p, s) => { files[p] = s } })
  const M = { modules: [], assignments: [], calendar: [], grades: null }
  const label = { id: 710, modname: "label", name: "Recordings(ENG) R1 R2", description: "<p>Recordings</p><p>(ENG) R1 R2 R3 R4 R5 R6 R7</p><p>(TUR) R1 R2 R3 R4 R5 R6 R7</p>" }
  M.modules.push(label)
  A.setPost(async (url, body) => {
    const p = Object.fromEntries(body.split("&").map(kv => kv.split("=").map(decodeURIComponent))), fn = p.wsfunction
    if (fn === "core_webservice_get_site_info") return { userid: 7, fullname: "Test" }
    if (fn === "core_enrol_get_users_courses") return [{ id: 1, shortname: "2026/2027-1 AD  216.01", startdate: NOW - 60 * DAY, enddate: NOW + 60 * DAY }]
    if (fn === "core_course_get_contents") return [{ id: 9, summary: "", modules: M.modules }]
    if (fn === "mod_assign_get_assignments") return { courses: [{ id: 1, assignments: M.assignments }] }
    if (fn === "core_calendar_get_calendar_events") return { events: M.calendar }
    if (fn === "gradereport_user_get_grade_items") {
      if (M.grades === null) return { exception: "x", errorcode: "nopermission", message: "kapalı" }
      return { usergrades: [{ gradeitems: M.grades }] }
    }
    return {}
  })
  const grade = (id, name, raw, graded, fb = "") => ({ id, itemname: name, itemtype: "mod", graderaw: raw, gradeformatted: raw.toFixed(2), grademax: 100, feedback: fb, gradedategraded: graded })

  // 1) v1.0.0 gibi: notlar yok (API kapalı), kayıtlarda etiket metni saklanmamış
  let st = A.loadState()
  let fresh = A.ingest(st, await A.collect("https://m", "tok", {}))
  check("not API'si kapalıyken çökmez", fresh.length, 0)
  for (const ex of Object.values(st.extracted)) if (!String(ex.kind).startsWith("duyuru")) delete ex.text     // 1.0.0 kayıt biçimi
  A.saveState(st)

  // 2) ertesi gün v1.1: R8 eklendi, yeni yükleme, yeni ödev (3 kopya), klasöre 2 dosya, notlar açıldı
  clock += DAY * 1000
  const T = Math.floor(clock / 1000), due = T + 3 * DAY
  label.description = "<p>Recordings</p><p>(ENG) R1 R2 R3 R4 R5 R6 R7 R8</p><p>(TUR) R1 R2 R3 R4 R5 R6 R7 R8</p>"
  M.modules.push(
    { id: 700, modname: "resource", name: "Answers to 4th Exercise", contents: [{ type: "file", filename: "Answers (Take Home).docx", filepath: "/", filesize: 10, timemodified: T }] },
    { id: 701, modname: "assign", name: "Homework 5", dates: [{ label: "Due:", timestamp: due }] },
    { id: 702, modname: "folder", name: "Problem Sets", contents: [
      { type: "file", filename: "PS7.pdf", filepath: "/", filesize: 1, timemodified: T }, { type: "file", filename: "PS8.pdf", filepath: "/", filesize: 1, timemodified: T }] })
  M.assignments = [{ id: 55, name: "Homework 5", duedate: due, intro: "" }]
  M.calendar = [{ id: 66, name: "Homework 5 is due", courseid: 1, timestart: due, modulename: "assign", description: "" }]
  M.grades = [grade(1, "3rd Exercise", 70, T - 20 * DAY), grade(2, "4th Exercise (Take Home)", 85, T - 3600, "<p>Well done</p>"),
    { id: 3, itemname: "Final", itemtype: "mod", graderaw: null }, { id: 4, itemname: "Course total", itemtype: "course", graderaw: 77 }]
  st = A.loadState()
  fresh = A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  A.saveState(st)
  check("anlık bildirim: sadece yeni not", fresh.map(f => f.kind + ":" + f.title), ["not:4th Exercise (Take Home)"])
  let m = A.buildModel(st, new Date(clock))
  check("yeni notlar: eski not ve ders toplamı yok", m.grades.map(g => [g.title, g.text.split("\n")[0], g.updated]), [["4th Exercise (Take Home)", "85/100", false]])
  const other = m.other.map(o => A.kindTr(o.kind) + ": " + o.title)
  check("resource + dosyası tek satır", other.filter(o => o.includes("Answers to 4th Exercise")), ["dosya: Answers to 4th Exercise / Answers (Take Home).docx"])
  check("ödev: etkinlik + ödev + takvim tek satır", other.filter(o => o.includes("Homework 5")), ["ödev: Homework 5"])
  check("klasördeki iki dosya ayrı kalır", other.filter(o => o.includes("Problem Sets")).length, 2)
  const rec = m.other.find(o => o.title.startsWith("Recordings"))
  check("1.0.0 kaydında metin yokken arşivden fark", [rec.updated, rec.change], [true, "+ R8"])
  const html = A.briefHtml(m)
  check("html: notlar bölümü, tür adları", [html.includes("📊 Notlar"), html.includes("85/100"), html.includes("Well done"), html.includes("sayfa metni"), html.includes("+ R8"), html.includes("etkinlik (")], [true, true, true, true, true, false])
  check("bildirim metninde not", A.notificationText(m).includes("📊 Yeni not: AD216 4th Exercise (Take Home) 85/100"), true)
  check("ödev haftada bir kez", m.week.filter(e => /Homework 5/.test(e.title)).length, 1)

  // 3) itirazla not değişti (iki gün sonra)
  clock += 2 * DAY * 1000
  M.grades[0] = grade(1, "3rd Exercise", 75, Math.floor(clock / 1000) - 60)
  st = A.loadState()
  fresh = A.ingest(st, await A.collect("https://m", "tok", st.replyCache))
  m = A.buildModel(st, new Date(clock))
  check("değişen not", m.grades.map(g => [g.title, g.text, g.updated]), [["3rd Exercise", "75/100", true]])
  check("değişen not anlık bildirimde", fresh.length, 1)

  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error("HATA:", e); process.exit(1) })
