// Moodle Brief — iPhone sürümü (Scriptable)
// icon-color: deep-blue; icon-glyph: graduation-cap;
// ------------------------------------------------------------------------------------------
// Her sabah Moodle'daki bugünkü teslimleri, haftanın olaylarını, en yakın sınavı ve yeni
// duyuruları bildirim olarak gönderir. Ana ekran widget'ı en yakın sınavları gösterir.
//
// GİZLİLİK: Her şey SADECE bu telefonda çalışır. Betiğin Moodle dışında tek bağlantısı, günde bir kez
// kurulum sayfasındaki sürüm dosyasını okumasıdır (yeni sürüm uyarısı). O istekte hiçbir veri gönderilmez
// ve Ayarlar'dan kapatılabilir. Giriş Moodle'ın kendi sayfasında (Busign)
// yapılır; betik şifreni görmez. Moodle'ın verdiği anahtar bu telefonun şifreli Keychain'inde,
// kayıtlar bu telefonun hafızasında durur. Hiçbir veri başka bir sunucuya gönderilmez.
// Kayıtlar asla silinmez; eskiyen ya da Moodle'dan kalkan öğeler sadece gösterilmez.
// ------------------------------------------------------------------------------------------

const VERSION = "1.6.0"
const RULES = "3"                        // tarih çıkarma kuralları değişince artar: kayıtlı duyurular yeniden taranır
const DEFAULT_URL = "https://moodle.bogazici.edu.tr"
const KC_TOKEN = "moodlebrief.token"
const KC_URL = "moodlebrief.url"
const NOTIF_MORNING = "moodlebrief.morning"
const NOTIF_DUE = "moodlebrief.due."
const NOTIF_UPDATE = "moodlebrief.update"
const INSTALL_URL = "https://kodmir.github.io/moodle-daily-brief/"
const UPDATE_URL = INSTALL_URL + "version.json"
const LOOKAHEAD_DAYS = 45
const FORUM_PAGE = 40                    // bir istekte gelen tartışma sayısı
const FORUM_PAGES = 5                    // forum başına en çok bu kadar sayfa okunur
// Etkinlik tarihinin etiketi Moodle'ın arayüz diline göre değişir ("Due:" / "Son teslim:"); 'dataid' değişmez
const DATE_IDS = { duedate: "teslim", timeclose: "kapanış", timeopen: "açılış", allowsubmissionsfromdate: "açılış",
  cutoffdate: "kesme tarihi", gradingduedate: "remind me to grade by" }

// ============================================================ zaman yardımcıları
let nowFn = () => new Date()             // testlerde dondurulur
const now = () => nowFn()
const GUN = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"]   // JS: 0=Pazar
const GUN_KISA = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"]
const AY_KISA = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]
const pad = n => String(n).padStart(2, "0")
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const fromYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d) }
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())
const daysBetween = (fromDate, ymdStr) => Math.round((fromYmd(ymdStr) - dayStart(fromDate)) / 86400000)
const trDate = d => `${d.getDate()} ${AY_KISA[d.getMonth()]} ${GUN_KISA[d.getDay()]}`
const dayMon = d => `${d.getDate()} ${AY_KISA[d.getMonth()]}`
const fmtTs = ts => { const d = new Date(ts * 1000); return `${ymd(d)} ${hm(d)} ${GUN[d.getDay()]}` }
const left = n => n === 0 ? "bugün" : n === 1 ? "yarın" : `${n} gün`

// ============================================================ metin yardımcıları
function unescapeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
}
function htmlToText(s) {
  if (!s) return ""
  s = String(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
  s = s.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>|<\/tr>/gi, "\n")
  s = s.replace(/<[^>]+>/g, " ")
  s = unescapeHtml(s)
  s = s.replace(/[ \t\r\f\v ]+/g, " ").replace(/\n\s*\n+/g, "\n\n")
  return s.trim()
}
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
function hash(...parts) {   // FNV-1a, iki tohum → 16 hex
  const str = parts.map(p => String(p)).join("||")
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}
// "2026/2027-1 IE  306.01" -> "IE306"
function shortCourse(name) {
  const s = unescapeHtml(name).replace(/^\s*\d{4}\/\d{4}-\d\s*/, "")
  const m = s.match(/([A-Za-zÇĞİÖŞÜçğıöşü]{2,6})\s*(\d{3}[A-Z]?)/)
  return m ? (m[1].toUpperCase() + m[2]) : s.trim()
}
const lowerEn = s => String(s || "").replace(/İ/g, "i").toLowerCase()          // MIDTERM -> midterm
const lowerTr = s => String(s || "").replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase()

// ============================================================ Moodle bağlantısı
class TransientError extends Error {}
class TokenError extends Error {}
class MoodleError extends Error {}
const WARNINGS = []

function flatten(obj, prefix = "", out = {}) {
  if (Array.isArray(obj)) obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out))
  else if (obj !== null && typeof obj === "object")
    Object.entries(obj).forEach(([k, v]) => flatten(v, prefix ? `${prefix}[${k}]` : k, out))
  else out[prefix] = typeof obj === "boolean" ? (obj ? 1 : 0) : obj
  return out
}
const arr = x => Array.isArray(x) ? x : []          // Moodle beklenmedik biçim döndürürse çökme
const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&")

let httpPost = async (url, body, contentType) => {        // testlerde değiştirilir
  const r = new Request(url)
  r.method = "POST"
  r.headers = { "Content-Type": contentType }
  r.body = body
  r.timeoutInterval = 30
  return await r.loadJSON()
}

let httpGet = async (url) => {                            // testlerde değiştirilir
  const r = new Request(url)
  r.timeoutInterval = 10
  return await r.loadJSON()
}

async function call(base, token, fn, params = {}) {
  let j, last
  for (let i = 0; i < 2; i++) {
    try {
      j = await httpPost(base + "/webservice/rest/server.php",
        form(Object.assign({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json" }, flatten(params))),
        "application/x-www-form-urlencoded")
      last = null
      break
    } catch (e) { last = e }
  }
  if (last) throw new TransientError(fn + ": " + (last.message || last))
  if (j && j.exception) {
    const code = String(j.errorcode || "").toLowerCase()
    if (["invalidtoken", "accessexception", "invalidlogin"].includes(code) &&
      ["core_webservice_get_site_info", "core_enrol_get_users_courses"].includes(fn))
      throw new TokenError(code)
    throw new MoodleError(fn + ": " + code + " — " + (j.message || ""))
  }
  return j
}
async function tryCall(base, token, fn, params, dflt) {
  try { return await call(base, token, fn, params) }
  catch (e) {
    if (e instanceof MoodleError) { WARNINGS.push(e.message); return dflt }
    throw e
  }
}

async function quietCall(base, token, fn, params) {
  try { return await call(base, token, fn, params) }
  catch (e) { if (e instanceof MoodleError || e instanceof TokenError) return null; throw e }
}

// ============================================================ toplama
function mk(key, kind, course, title, text = "", t = null, version = null, url = "", file = null, extract = true) {
  title = unescapeHtml(title || "")
  return { key, kind, course, title, text, time: t, version: version || hash(title, text), url, file, extract }
}
function structEv(course, title, type, ts, source) {
  const d = new Date(ts * 1000)
  return { course, title, type, date: ymd(d), time: hm(d), certainty: "exact", source }
}

// Not öğesini "85/100" gibi yazar; harf notu ise olduğu gibi bırakır
function fmtGrade(g) {
  const has = g.gradeformatted !== null && g.gradeformatted !== undefined && g.gradeformatted !== ""
  const val = String(has ? g.gradeformatted : g.graderaw).trim()
  const n = Number(val.replace(",", "."))
  if (val === "" || Number.isNaN(n)) return val
  const num = String(parseFloat(n.toFixed(2))), mx = Number(g.grademax)
  return mx ? `${num}/${parseFloat(mx.toFixed(2))}` : num
}

// gradereport_user_get_grades_table çıktısını not kalemlerine çevirir (kategori/toplam ve boş notlar atlanır)
function gradesFromTable(res) {
  const out = []
  for (const tb of arr(res && res.tables)) for (const row of arr(tb.tabledata)) {
    if (!row || typeof row !== "object" || !row.itemname || typeof row.itemname !== "object") continue
    const cell = row.itemname, cls = String(cell.class || "")
    const name = htmlToText(cell.content).replace(/\s+/g, " ").trim()
    const grade = row.grade && typeof row.grade === "object" ? htmlToText(row.grade.content) : ""
    if (!name || !grade || ["-", "–", "—"].includes(grade)) continue
    if (/category|courseitem|bagg/.test(cls) || /(^|[^\p{L}])(total|toplam[ıi]?)($|[^\p{L}])/iu.test(name)) continue
    const rid = String(cell.id || "").match(/row_(\d+)_/)
    const rng = row.range && typeof row.range === "object" ? htmlToText(row.range.content) : ""
    const mx = rng.match(/\d+(?:[.,]\d+)?/g)
    out.push({ id: rid ? rid[1] : "n" + hash(name), itemname: name.replace(/^Manual item\s+(?=\S)/, ""), graderaw: grade, gradeformatted: grade,
      grademax: mx ? Number(mx[mx.length - 1].replace(",", ".")) : null,
      feedback: row.feedback && typeof row.feedback === "object" ? row.feedback.content : "" })
  }
  return out
}

async function collect(base, token, replyCache) {
  const info = await call(base, token, "core_webservice_get_site_info")
  const all = arr(await call(base, token, "core_enrol_get_users_courses", { userid: info.userid }))
  const nowTs = Math.floor(now() / 1000)
  const courses = all.filter(c => {
    if (c.hidden) return false
    const s = c.startdate || 0, e = c.enddate || 0
    return e ? (e > nowTs - 14 * 86400 && s < nowTs + 30 * 86400) : s > nowTs - 200 * 86400
  })
  const cname = {}
  courses.forEach(c => { cname[c.id] = shortCourse(c.shortname || c.fullname || String(c.id)) })
  const cids = courses.map(c => c.id)
  const items = [], struct = [], newCache = {}
  let capped = false

  // 1) ders içerikleri
  for (const c of courses) {
    const cn = cname[c.id]
    const secs = arr(await tryCall(base, token, "core_course_get_contents", { courseid: c.id }, []))
    for (const s of secs) {
      const summ = htmlToText(s.summary)
      if (summ) items.push(mk(`section:${c.id}:${s.id}`, "bölüm", cn, s.name || "Bölüm açıklaması", summ))
      for (const mod of arr(s.modules)) {
        if (mod.uservisible === false) continue
        const desc = htmlToText(mod.description)
        const dates = arr(mod.dates).filter(d => d.timestamp).map(d => `${d.label}: ${fmtTs(d.timestamp)}`)
        const urls = arr(mod.contents).filter(x => x.type === "url").map(x => x.fileurl || "")
        const text = [desc, dates.join("\n"), urls.join("\n")].filter(Boolean).join("\n")
        items.push(mk(`mod:${mod.id}`, `etkinlik (${mod.modname})`, cn, mod.name, text, null, null,
          mod.url || "", null, Boolean(desc || dates.length)))
        for (const d of arr(mod.dates)) {
          if (!d.timestamp || d.timestamp <= nowTs - 86400) continue
          let lab = String(d.label || "").replace(/[\s:]+$/, "").trim().toLowerCase()
          lab = { due: "teslim", closes: "kapanış", opens: "açılış", closed: "kapanış", opened: "açılış" }[lab] || lab
          lab = DATE_IDS[String(d.dataid || "").toLowerCase()] || lab
          if (lab === "açılış" && mod.modname !== "quiz") continue
          if (["cut-off date", "remind me to grade by", "kesme tarihi"].includes(lab)) continue
          const title = lab && lab !== "teslim" ? `${unescapeHtml(mod.name)} (${lab})` : unescapeHtml(mod.name)
          struct.push(structEv(cn, title, mod.modname, d.timestamp, "moodle"))
        }
        for (const f of arr(mod.contents)) {
          if (f.type !== "file") continue
          const tm = f.timemodified || f.timecreated
          items.push(mk(`file:${mod.id}:${f.filepath || "/"}${f.filename}`, mod.modname === "page" ? "sayfa" : "dosya",
            cn, mod.modname === "page" ? mod.name : `${unescapeHtml(mod.name)} / ${f.filename}`, "", tm,
            `${tm}:${f.filesize}`, mod.url || "", { name: f.filename, size: f.filesize || 0 }))
        }
      }
    }
  }

  // 2) duyurular ve forumlar (+ cevaplar)
  const forums = arr(await tryCall(base, token, "mod_forum_get_forums_by_courses", { courseids: cids }, []))
  for (const fo of forums) {
    const cn = cname[fo.course] || "?"
    const kind = fo.type === "news" ? "duyuru" : "forum"
    // Forumun tamamı okunur (40'ar 40'ar): yoksa en yeni 40'ın dışında kalan eski bir duyuru "Moodle'dan kalkmış"
    // sanılıp içindeki sınav tarihiyle birlikte gizlenirdi.
    const discs = [], doneIds = new Set()
    let full = true
    for (let page = 0; page < FORUM_PAGES; page++) {
      let res = await tryCall(base, token, "mod_forum_get_forum_discussions", { forumid: fo.id, page, perpage: FORUM_PAGE }, null)
      if (!res) res = await tryCall(base, token, "mod_forum_get_forum_discussions_paginated",
        { forumid: fo.id, sortby: "timemodified", sortdirection: "DESC", page, perpage: FORUM_PAGE }, {})
      const batch = arr(res && res.discussions)
      discs.push(...batch)
      if (batch.length < FORUM_PAGE) { full = false; break }
    }
    if (full) capped = true             // forum bitmedi: görünmeyen eski tartışmalar "kaldırıldı" sayılmaz
    for (const d of discs) {
      const did = d.discussion || d.id
      if (doneIds.has(did)) continue    // sayfalar arasında kayan (sabitlenmiş) tartışma
      doneIds.add(did)
      const tm = d.modified || d.timemodified || d.created
      const subj = String(d.subject || d.name || "(konu yok)").trim()
      const body = htmlToText(d.message)
      const atts = Array.isArray(d.attachments) ? d.attachments : []
      let text = `Gönderen: ${d.userfullname || "?"}\nTarih: ${fmtTs(d.created || tm)}\n\n${body}`
      if (atts.length) text += "\n\nEkler: " + atts.map(a => a.filename).join(", ")
      items.push(mk(`disc:${did}`, kind, cn, subj, text, d.created || tm, hash(tm, subj, body),
        `${base}/mod/forum/discuss.php?d=${did}`))
      if ((d.numreplies || 0) > 0) {
        const ck = `${tm}:${d.numreplies}`, cached = replyCache[did]
        if (cached && cached.v === ck) { items.push(...cached.items); newCache[did] = cached }
        else {
          const pr = await tryCall(base, token, "mod_forum_get_discussion_posts", { discussionid: did }, null)
          if (!pr) { if (cached) { items.push(...cached.items); newCache[did] = cached } }
          else {
            const reps = []
            for (const p of arr(pr.posts)) {
              if (!p.parentid || p.id === d.id) continue
              const ptxt = htmlToText(p.message)
              if (!ptxt) continue
              const pt = p.timecreated || p.created || tm
              reps.push(mk(`reply:${p.id}`, `${kind} cevabı`, cn, `Re: ${subj}`,
                `Gönderen: ${(p.author && p.author.fullname) || "?"}\nTarih: ${fmtTs(pt)}\n\n${ptxt}`, pt,
                hash(p.timemodified || pt, ptxt), `${base}/mod/forum/discuss.php?d=${did}#p${p.id}`))
            }
            items.push(...reps)
            newCache[did] = { v: ck, items: reps }
          }
        }
      }
      for (const a of atts) if (a.fileurl)
        items.push(mk(`att:${did}:${a.filename}`, `${kind} eki`, cn, `${subj} / ${a.filename}`, "", tm,
          `${a.timemodified || tm}:${a.filesize}`, "", { name: a.filename, size: a.filesize || 0 }))
    }
  }

  // 3) ödevler
  const asg = await tryCall(base, token, "mod_assign_get_assignments", { courseids: cids }, {}) || {}
  for (const c of arr(asg.courses)) {
    const cn = cname[c.id] || shortCourse(c.shortname)
    for (const a of arr(c.assignments)) {
      const due = a.duedate || 0, intro = htmlToText(a.intro)
      items.push(mk(`assign:${a.id}`, "ödev", cn, a.name, `Son teslim: ${due ? fmtTs(due) : "belirtilmemiş"}\n${intro}`,
        a.timemodified, hash(a.name, due, intro)))
      if (due && due > nowTs - 86400) {
        const ev = structEv(cn, unescapeHtml(a.name), "ödev teslimi", due, "moodle ödev")
        // yaklaşan ödev teslim edilmiş mi? (edildiyse hatırlatma yapılmaz, ✓ gösterilir)
        if (due > nowTs && due < nowTs + 14 * 86400) {
          const sub = await quietCall(base, token, "mod_assign_get_submission_status", { assignid: a.id })
          const la = sub && typeof sub === "object" ? sub.lastattempt : null
          const stt = la && ((la.submission && la.submission.status) || (la.teamsubmission && la.teamsubmission.status))
          if (stt === "submitted") ev.done = true
        }
        struct.push(ev)
      }
    }
  }

  // 4) quizler
  const qz = await tryCall(base, token, "mod_quiz_get_quizzes_by_courses", { courseids: cids }, {}) || {}
  for (const q of arr(qz.quizzes)) {
    const cn = cname[q.course] || "?", o = q.timeopen || 0, cl = q.timeclose || 0, intro = htmlToText(q.intro)
    items.push(mk(`quiz:${q.id}`, "quiz", cn, q.name,
      `Açılış: ${o ? fmtTs(o) : "-"}\nKapanış: ${cl ? fmtTs(cl) : "-"}\n${intro}`, null, hash(q.name, o, cl, intro)))
    if (o && o > nowTs - 86400) struct.push(structEv(cn, unescapeHtml(q.name), "quiz açılış", o, "moodle quiz"))
    if (cl && cl > nowTs - 86400) struct.push(structEv(cn, unescapeHtml(q.name), "quiz kapanış", cl, "moodle quiz"))
  }

  // 5) takvim
  const t0 = nowTs - 86400, t1 = nowTs + LOOKAHEAD_DAYS * 86400
  const cal = arr(((await tryCall(base, token, "core_calendar_get_calendar_events",
    { events: { courseids: cids }, options: { userevents: 1, siteevents: 1, timestart: t0, timeend: t1 } }, {}) || {}).events))
  const act = arr(((await tryCall(base, token, "core_calendar_get_action_events_by_timesort",
    { timesortfrom: t0, timesortto: t1, limitnum: 50 }, {}) || {}).events))
  const ids = new Set(cal.map(e => e.id))
  for (const e of act) if (!ids.has(e.id)) {
    e.timestart = e.timestart || e.timesort
    e.courseid = e.courseid || (e.course && e.course.id)
    cal.push(e)
  }
  for (const e of cal) {
    const ts = e.timestart || e.timesort
    if (!ts) continue
    const cn = cname[e.courseid] || "Genel", desc = htmlToText(e.description)
    const sev = structEv(cn, unescapeHtml(e.name), e.modulename || e.eventtype || "etkinlik", ts, "moodle takvim")
    if (e.eventtype) sev.etype = String(e.eventtype)
    struct.push(sev)
    items.push(mk(`cal:${e.id}`, "takvim", cn, e.name, `${fmtTs(ts)}\n${desc}`, e.timemodified,
      hash(e.name, ts, desc), "", null, Boolean(desc)))
  }

  // 6) bildirimler (not girildi vb.)
  const nt = await tryCall(base, token, "message_popup_get_popup_notifications", { useridto: info.userid, limit: 50, offset: 0 }, {}) || {}
  for (const n of arr(nt.notifications)) {
    const body = n.smallmessage || htmlToText(n.fullmessagehtml) || n.fullmessage || ""
    items.push(mk(`notif:${n.id}`, "bildirim", "Bildirim", n.subject, body, n.timecreated, "1", n.contexturl || ""))
  }

  // 7) notlar (hoca not girdiğinde / değiştirdiğinde)
  for (const c of courses) {
    const gr = await tryCall(base, token, "gradereport_user_get_grade_items", { courseid: c.id, userid: info.userid }, null)
    // Bazı derslerde Moodle bu raporu üretemiyor (invalidresponse): not tablosundan oku
    const rows = gr ? arr(gr.usergrades).flatMap(ug => arr(ug.gradeitems))
        .filter(g => ["mod", "manual"].includes(g.itemtype) && g.graderaw !== null && g.graderaw !== undefined)
      : gradesFromTable(await tryCall(base, token, "gradereport_user_get_grades_table", { courseid: c.id, userid: info.userid }, {}))
    for (const g of rows) {
      const fb = htmlToText(g.feedback)
      items.push(mk(`grade:${c.id}:${g.id}`, "not", cname[c.id], g.itemname || "Not", fmtGrade(g) + (fb ? "\n" + fb : ""),
        g.gradedategraded || g.gradedatesubmitted || null, hash(g.graderaw, fb), "", null, false))
    }
  }

  const uniq = {}
  items.forEach(it => { uniq[it.key] = it })
  const sd = {}
  struct.forEach(e => { sd[hash(e.course, e.title, e.date, e.time)] = e })
  return { user: info.fullname, items: Object.values(uniq), struct: Object.values(sd), replyCache: newCache, courses,
    noHide: capped ? ["disc:", "reply:", "att:"] : [] }
}

// ============================================================ metinden tarih çıkarma
const TR_AY = { ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6, temmuz: 7,
  ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11, aralık: 12, aralik: 12 }
const EN_AY = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, sept: 9, october: 10, november: 11, december: 12 }
const EN_KISA = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const KEYWORDS = [
  ["midterm", "midterm|mid-term|ara ?s[ıi]nav|vize"],
  ["final", "\\bfinal(?!ly|i[sz]|ist)"],                 // "finally", "finalize" değil
  ["quiz", "quiz"],
  ["exam", "exam(?!pl|in(?:e|ing))|s[ıi]nav"],           // "example", "examine" değil
  ["assignment", "[öo]dev|homework|\\bhw ?\\d|assignment|\\bdue\\b(?!\\s+to\\b)|teslim|deadline|submission"],   // "due to" değil
  ["project", "proje|project"],
  ["presentation", "sunum|presentation"],
  ["lab", "\\blab"],
  ["review", "objections?|itiraz|review session|paper viewing|ka[ğg][ıi]t inceleme"],
  ["class_change", "iptal|cancel|telafi|make-?up|ertelen|postpone|resched"],
]
const TYPE_LABEL = { midterm: "Ara sınav", final: "Final", quiz: "Quiz", exam: "Sınav", assignment: "Ödev",
  project: "Proje", presentation: "Sunum", lab: "Lab", class_change: "Ders değişikliği", review: "İtiraz/inceleme" }
const EXAM_RE = /midterm|mid-term|vize|s[ıiIİ]nav|\bfinal(?!ly|i[sz]|ist)|quiz|exam(?!pl|in(?:e|ing))/i
const WEEKDAYS = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
  pazartesi: 1, salı: 2, sali: 2, çarşamba: 3, carsamba: 3, perşembe: 4, persembe: 4, cuma: 5, cumartesi: 6, pazar: 0 }
const WD_ALT = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|")
const WL = "(?<![\\p{L}\\p{N}_])", WR = "(?![\\p{L}\\p{N}_])"   // Türkçe harflerle çalışan kelime sınırı
const RE_DAY_MON = /(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\.?\s*(?:of\s+)?([A-Za-zÇĞİÖŞÜçğıöşü]{3,9})(?:[\s,]+(20\d\d))?/g
const RE_MON_DAY = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(20\d\d))?/g
const RE_NUM = /(?<![\d.,/:])(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?!\d|[./:]\d)/g
const RE_TIME = /(?:saat\s*|at\s*|@\s*)?\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/
const RE_AMPM = /\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/
const RE_WD = new RegExp(WL + "(" + WD_ALT + ")" + WR, "u")
const RE_NOT_EVENT_AFTER = new RegExp(
  "^\\s*(?:#?\\s*\\d+\\s*)?(?:(?:exam(?:ination)?s?|tests?|s[ıi]nav[ıi]?)\\s+)?(?:(?:silent|paper|kağıt)\\s+)?" +
  "(?:topics?|review|grades?|results?|papers?|objections?|solutions?|coverage|scope|" +
  "preparation|prep|classroom assignments?|seating|notları|notlar|konuları|kapsamı|sonuçları|kağıtları|" +
  "itiraz|çözümleri|hazırlık|grading|viewing|re-?evaluation|answer keys?|averages?|statistics|inceleme|ortalamas[ıi])" +
  "|^s?\\s*(?:#?\\s*\\d+\\s+)?(?:date\\s+|dates\\s+|details\\s+|tarihi\\s+)?(?:will be|is to be|are to be|to be|is going to be)\\s+" +
  "(?:announced|posted|shared|published|released|made)" +
  "|^s?\\S*\\s*(?:\\S+\\s+){0,3}(?:duyurulacak|açıklanacak|ilan edilecek|paylaşılacak)")
const RE_NOT_EVENT_BEFORE = /(?:before|after|for|until|prior to|öncesi|sonrası|için)\s+(?:the\s+)?$/
const RE_OLD_BEFORE = /(?:\bfrom|instead of|rather than|previously|originally|was scheduled (?:for|on)|was planned (?:for|on)|moved from|eski tarih|önceki tarih)\s*(?:the\s+|on\s+)?$/
const RE_OLD_AFTER = /^\s*(?:'?(?:dan|den|tan|ten)\b)?\s*(?:tarihinden|tarihindeki|yerine)/
const RE_REL_DAY = new RegExp(WL + "(yarın(?:ki|da)?|yarin(?:ki|da)?|tomorrow|bugün(?:kü|ki)?|bugun(?:ku|ki)?|today|tonight|bu akşam(?:ki)?)" + WR, "gu")
const RE_REL_WD = new RegExp(WL + "(this|next|coming|on|bu|önümüzdeki|gelecek|haftaya)\\s+(?:week\\s+|hafta(?:ki)?\\s+)?(" + WD_ALT + ")" + WR, "gu")
const SPECIFIC_EXAMS = ["midterm", "final", "quiz"]
const RE_PLACE_BEFORE = /(?<![\p{L}\p{N}])(?:at|in|@)\s+(?:the\s+)?(?:[\p{L}\p{N}.&-]+\s+){0,2}$/u
const RE_REVIEW = /objections?|itiraz|review session|paper viewing|ka[ğg][ıi]t inceleme/

function monthOf(word) {
  const w = lowerTr(word)
  for (const [name, m] of Object.entries(TR_AY)) if (w.startsWith(name)) return m
  const w2 = word.toLowerCase()
  return EN_AY[w2] || EN_KISA[w2] || null
}
function makeDate(day, mon, year) {
  const today = dayStart(now())
  const valid = (y) => { const d = new Date(y, mon - 1, day); return d.getMonth() === mon - 1 && d.getDate() === day ? d : null }
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null
  if (year) return valid(year < 100 ? year + 2000 : year)
  let d = valid(today.getFullYear())
  if (d && d < addDays(today, -60)) d = valid(today.getFullYear() + 1)
  return d
}
function span(text, s, e) {
  const a = Math.max(text.lastIndexOf("\n", s - 1), text.lastIndexOf(". ", s - 1), text.lastIndexOf("! ", s - 1), text.lastIndexOf("? ", s - 1)) + 1
  const ends = ["\n", ". ", "! ", "? "].map(x => text.indexOf(x, e)).filter(x => x !== -1)
  return [a, ends.length ? Math.min(...ends) : text.length]
}
function sentence(text, s, e) {
  const [a, b] = span(text, s, e)
  const t = text.slice(a, b).replace(/\s+/g, " ").replace(/^[\s.\-:]+|[\s.\-:]+$/g, "")
  return t.length <= 80 ? t : t.slice(0, 77) + "…"
}
function findTime(text, s, e) {
  for (const seg of [text.slice(e, e + 35), text.slice(Math.max(0, s - 25), s)]) {
    const tm = seg.match(RE_TIME), ap = seg.toLowerCase().match(RE_AMPM)
    if (ap && (!tm || ap.index <= tm.index)) {
      const hh = (+ap[1]) % 12 + (ap[3].startsWith("p") ? 12 : 0)
      return `${pad(hh)}:${ap[2] || "00"}`
    }
    if (tm) return `${pad(+tm[1])}:${tm[2]}`
  }
  return null
}
function classify(low, s, a, b) {
  let best = null, bestDist = 1e9
  const sentenceLow = low.slice(a, b)
  for (const [typ, pat] of KEYWORDS) {
    const re = new RegExp(pat, "g")
    let km
    while ((km = re.exec(sentenceLow))) {
      const ks = a + km.index, ke = ks + km[0].length
      if (RE_NOT_EVENT_AFTER.test(low.slice(ke, ke + 50)) || RE_NOT_EVENT_BEFORE.test(low.slice(Math.max(0, ks - 15), ks))) continue
      if (typ === "lab" && RE_PLACE_BEFORE.test(low.slice(Math.max(0, ks - 40), ks)) && !/^(?:oratory)?\s*\p{L}/u.test(low.slice(ke, ke + 14))) continue
      const dist = Math.abs(ks - s) + (typ === "exam" ? 40 : 0)
      if (dist < bestDist) { best = typ; bestDist = dist }
      if (km[0].length === 0) re.lastIndex++
    }
  }
  return best
}
function refine(best, low, s, titleLow, sentenceLow = "") {
  if (best === null && /session|oturum/.test(sentenceLow) && RE_REVIEW.test(low.slice(Math.max(0, s - 220), s))) return "review"
  if (best !== "exam") return best
  for (const src of [low.slice(Math.max(0, s - 220), s), titleLow]) {
    let found = null
    for (const [typ, pat] of KEYWORDS) {
      if (!SPECIFIC_EXAMS.includes(typ)) continue
      const re = new RegExp(pat, "g")
      let km
      while ((km = re.exec(src))) {
        if (RE_NOT_EVENT_AFTER.test(src.slice(km.index + km[0].length, km.index + km[0].length + 30))) continue
        found = typ
      }
    }
    if (found) return found
  }
  return best
}

function regexDates(text, posted = null, title = "") {
  if (!text) return []
  text = text.split("\n").filter(l => !/^(Gönderen|Tarih|Son teslim|Açılış|Kapanış):/.test(l)).join("\n")
  const low = lowerEn(text), titleLow = lowerEn(title)
  const found = {}, cands = [], taken = []
  for (const m of text.matchAll(RE_DAY_MON)) {
    const mon = monthOf(m[2])
    if (m[2] === "may" && !m[3]) continue        // "Quiz 2 may be postponed": küçük harfli 'may' fiildir, Mayıs değil
    if (mon) cands.push([m.index, m.index + m[0].length, +m[1], mon, m[3], true, false])
  }
  for (const m of text.matchAll(RE_MON_DAY)) {
    const mon = monthOf(m[1])
    const w = m[1].toLowerCase()
    if (m[1] === "may" && !m[3]) continue
    if (mon && (w in EN_AY || w in EN_KISA)) cands.push([m.index, m.index + m[0].length, +m[2], mon, m[3], true, false])
  }
  for (const m of text.matchAll(RE_NUM)) {
    if (!m[3] && m[2].length !== 2) continue
    const before = text.slice(Math.max(0, m.index - 12), m.index).toLowerCase()
    if (/(section|chapter|sec\.|bölüm|ch\.|•|-|v|version|sürüm)\s*$/.test(before)) continue
    if (!m[3] && /(?:\bat|\bsaat|@)\s*$/.test(before)) continue     // "at 9.10", "saat 14.05": saat, tarih değil
    cands.push([m.index, m.index + m[0].length, +m[1], +m[2], m[3], Boolean(m[3]), true])
  }
  const today = dayStart(now())
  for (const [s, e, day, mon, year, strong, numeric] of cands) {
    if (taken.some(([ts, te]) => s < te && e > ts)) continue
    if (RE_OLD_BEFORE.test(low.slice(Math.max(0, s - 30), s)) || RE_OLD_AFTER.test(low.slice(e, e + 20))) { taken.push([s, e]); continue }
    const y = year ? +year : null
    let d = makeDate(day, mon, y)
    const [a, b] = span(text, s, e)
    const wdm = low.slice(a, b).match(RE_WD)
    let wdFlag = false
    if (wdm) {
      const wd = WEEKDAYS[wdm[1]]
      if (numeric && (!d || d.getDay() !== wd)) {
        const alt = makeDate(mon, day, y)
        if (alt && alt.getDay() === wd) d = alt
        else if (d) wdFlag = true
      } else if (d && d.getDay() !== wd && !numeric) wdFlag = true
    }
    if (!d) continue
    if (d < addDays(today, -60) || d > addDays(today, year ? 365 : 200)) continue
    const best = refine(classify(low, s, a, b), low, s, titleLow, low.slice(a, b))
    if (best === null && !strong) continue
    taken.push([s, e])
    const key = `${ymd(d)}:${best}`
    if (!found[key]) {
      found[key] = { title: sentence(text, s, e), type: best || "other", date: ymd(d), time: findTime(text, s, e),
        certainty: "approximate", detail: "metinden" }
      if (wdFlag) found[key].weekday_mismatch = true
    }
  }
  if (posted) {
    const pd = dayStart(new Date(posted * 1000))
    const rels = []
    for (const m of low.matchAll(RE_REL_DAY)) {
      const w = m[1]
      rels.push([m.index, m.index + m[0].length, addDays(pd, /^(yar|tom)/.test(w) ? 1 : 0)])
    }
    for (const m of low.matchAll(RE_REL_WD)) {
      const wd = WEEKDAYS[m[2]]
      let delta = ((wd - pd.getDay()) + 7) % 7 || 7
      if (["gelecek", "haftaya"].includes(m[1])) {
        const isoMon = d0 => { const x = dayStart(d0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime() }
        if (isoMon(addDays(pd, delta)) === isoMon(pd)) delta += 7
      }
      rels.push([m.index, m.index + m[0].length, addDays(pd, delta)])
    }
    for (const [s, e, d] of rels) {
      const [a, b] = span(text, s, e)
      if (taken.some(([ts]) => a <= ts && ts < b)) continue
      const best = refine(classify(low, s, a, b), low, s, titleLow, low.slice(a, b))
      if (best === null) continue
      if (d < addDays(today, -7) || d > addDays(today, 60)) continue
      const key = `${ymd(d)}:${best}`
      if (!found[key]) found[key] = { title: sentence(text, s, e), type: best, date: ymd(d), time: findTime(text, s, e),
        certainty: "approximate", detail: "göreli" }
    }
  }
  return Object.values(found)
}

function freeExtract(it) {
  if (it.file) return { summary: `Dosya: ${it.file.name}`, importance: "low", events: [] }
  const relOk = ["duyuru", "forum", "duyuru cevabı", "forum cevabı", "mesaj", "bildirim"].includes(it.kind)
  const events = !["takvim", "not"].includes(it.kind) ? regexDates(it.text || "", relOk ? it.time : null, it.title || "") : []
  return { summary: String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 160), events }
}

// ============================================================ birleştirme
const ROMAN = { i: "1", ii: "2", iii: "3" }
function examSlot(e) {
  const typ = e.type || "", title = lowerEn(e.title)
  const m = title.match(/(?:midterm|mid-term|ara s[ıi]nav|vize|quiz|exam|s[ıi]nav)\s*#?\s*(\d|iii|ii|i)\b/) ||
    title.match(/\b(\d)(?:st|nd|rd|th)\s+(?:midterm|exam|quiz)/) || title.match(/\b(\d)\.\s*(?:ara s[ıi]nav|vize|quiz|s[ıi]nav)/)
  const num = m ? (ROMAN[m[1]] || m[1]) : ""
  if (["midterm", "final", "quiz", "exam"].includes(typ)) {
    const b = typ === "exam" && /midterm|ara s[ıi]nav|vize/.test(title) ? "midterm" : typ
    return b + num
  }
  return null
}
function exactSlot(e) {
  const t = (e.type || "").toLowerCase(), title = lowerEn(e.title)
  let typ
  if (t.includes("quiz") || title.includes("quiz")) typ = "quiz"
  else if (/midterm|mid-term|ara s[ıi]nav|vize/.test(title)) typ = "midterm"
  else if (/\bfinal/.test(title)) typ = "final"
  else return null
  if (/\((?:açılış|kapanış)\)/.test(title)) return null
  return examSlot({ type: typ, title })
}
function supersede(evs) {
  const groups = {}, out = []
  for (const e of evs) {
    const slot = examSlot(e)
    if (!slot) out.push(e)
    else (groups[e.course + "|" + slot] = groups[e.course + "|" + slot] || []).push(e)
  }
  for (const [gk, g] of Object.entries(groups)) {
    if (new Set(g.map(x => x.date)).size === 1) { out.push(...g); continue }
    const newest = Math.max(...g.map(x => x.posted || 0))
    const keep = g.filter(x => (x.posted || 0) === newest)
    const keepDates = new Set(keep.map(x => x.date))
    let old = [...new Set(g.filter(x => (x.posted || 0) !== newest).map(x => x.date))].filter(d => !keepDates.has(d)).sort()
    // Numarasız quiz/sınav her hafta yeniden duyurulur ("Quiz Pazartesi"). Eski tarih, yeni duyuru yazıldığında
    // zaten geçmişse bu bir tarih değişikliği değil, sıradaki quizdir.
    if (["quiz", "exam"].includes(gk.slice(gk.lastIndexOf("|") + 1))) {
      const written = ymd(new Date(newest * 1000))
      old = old.filter(d => d >= written)
    }
    // uyarı, değişiklik tazeyken ya da eski tarih henüz geçmemişken işe yarar; sonrası tekrar olur
    const fresh = newest > now() / 1000 - STALE_DAYS * 86400 || (old.length > 0 && daysBetween(now(), old[old.length - 1]) >= 0)
    keep.forEach(x => { if (old.length && fresh) x.changed_from = old[old.length - 1] })
    out.push(...keep)
  }
  return out
}
const STOP = new Set(["due", "is", "closes", "close", "opens", "open", "kapanış", "açılış", "son", "teslim", "tarihi",
  "the", "submission", "deadline", "assignment", "ödev", "quiz"])
const normTitle = t => lowerEn(t).replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(w => w && !STOP.has(w)).join(" ")
const sameThing = (a, b) => { const x = normTitle(a), y = normTitle(b); return Boolean(x && y) && (x.includes(y) || y.includes(x)) }
// "Exam review session", "Quiz 1 objection", "sınav kağıdı inceleme": sınavın kendisi değil, sonrası
const RE_EXAM_AFTERMATH = /objection|itiraz|review|grades?(?![\p{L}])|results?(?![\p{L}])|papers?(?![\p{L}])|viewing|re-?evaluation|scheduler|notlar|sonuç|kağıt|inceleme/iu
// Adında sınav kelimesi geçse de teslim/anket olan Moodle kayıtları ("Midterm Project Report" ödevi) sınav değildir
const DEADLINE_TYPES = new Set(["assign", "ödev teslimi", "assignment", "project", "feedback", "choice", "scheduler", "workshop",
  "folder", "resource", "url", "page", "label", "forum", "questionnaire", "survey", "data", "glossary", "wiki"])
const CALENDAR_TYPES = new Set(["", "course", "user", "site", "group", "category", "etkinlik"])
function isExam(e) {
  const t = (e.type || "").toLowerCase()
  if (["midterm", "final", "quiz", "exam"].includes(t) || t.includes("quiz")) return true
  if (DEADLINE_TYPES.has(t)) return false
  return EXAM_RE.test(e.title || "") && !RE_EXAM_AFTERMATH.test(e.title || "")
}
// Moodle'da 00:00 teslim = önceki gecenin sonu: karşılaştırmalar gösterilen güne göre yapılır
const shownDay = e => { const d = fromYmd(e.date); return ymd(e.time === "00:00" ? addDays(d, -1) : d) }

function mergedEvents(struct, docEvents, asOf) {
  const prio = { "moodle ödev": 0, "moodle quiz": 1, "moodle": 2, "moodle takvim": 3 }
  const out = []
  for (const e of [...struct].sort((a, b) => (prio[a.source] ?? 9) - (prio[b.source] ?? 9))) {
    if (out.some(o => o.course === e.course && o.date === e.date && o.time === e.time && sameThing(o.title, e.title))) continue
    out.push({ ...e })
  }
  const exactSlots = new Set(out.map(o => [o.course, exactSlot(o)]).filter(x => x[1]).map(x => x.join("|")))
  const fam = t => ["assignment", "project"].includes(t) ? "work" : t      // ödev ve proje teslimi aynı aile
  for (const e of docEvents) {
    const typ = e.type || "other"
    if (typ === "other") continue
    const sl = examSlot(e)
    if (sl && exactSlots.has(e.course + "|" + sl)) continue
    const day = shownDay(e), item = String(e.item || ""), notif = item.startsWith("notif:")
    if (["assignment", "project"].includes(typ) && /^(assign|mod|cal):/.test(item)) {
      // Tarih, bir ödevin KENDİ açıklamasından geliyor. Moodle'daki teslim tarihiyle aynıysa tekrardır; birkaç gün
      // farklıysa ayrı bir iş değil, hocanın yazdığı tarihle sistemdeki tarihin çelişkisidir (uyarıyla tek satır).
      // Daha uzak bir tarih ayrı bir aşamadır ("taslak 10 Kas") ve ayrı kalır.
      const own = out.find(o => o.certainty === "exact" && o.course === e.course && !/\(açılış\)$/.test(o.title) &&
        sameThing(o.title, e.source || ""))
      const gap = own ? Math.abs(daysBetween(fromYmd(shownDay(own)), day)) : null
      if (own && gap === 0) continue
      if (own && gap <= 3) {
        own.text_dates = own.text_dates || []
        if (!own.text_dates.includes(e.date)) own.text_dates.push(e.date)
        continue
      }
    }
    // aynı şey mi? Tek istisna: bir teslimle aynı güne düşen, SAATİ FARKLI itiraz oturumu / ders değişikliği ayrı
    // bir olaydır (saatler aynıysa Moodle kaydı zaten o oturumdur: randevu modülü)
    if (out.some(o => {
      if (o.course !== e.course && !notif) return false
      if (shownDay(o) !== day) return false
      const exact = o.certainty === "exact"
      return (isExam(o) && isExam(e)) || sameThing(o.title, e.title) || (!exact && fam(o.type) === fam(typ)) ||
        (notif && isExam(o) === isExam(e)) ||
        (exact && !isExam(o) && !isExam(e) && !(["review", "class_change"].includes(typ) &&
          !CALENDAR_TYPES.has((o.type || "").toLowerCase()) && o.time && e.time && o.time !== e.time))
    })) continue
    out.push({ ...e })
  }
  for (const e of out) {
    let d = fromYmd(e.date), t = e.time
    if (t === "00:00") { d = addDays(d, -1); t = "23:59" }       // 00:00 teslim = önceki gecenin sonu
    e._d = d; e._t = t; e._n = daysBetween(asOf, ymd(d))
    e._past = e._n === 0 && Boolean(t) && t < hm(asOf)          // bugün ama saati geçti
  }
  return out.filter(e => e._n >= 0 && e._n <= LOOKAHEAD_DAYS).sort((a, b) => (a._d - b._d) || String(a._t || "99").localeCompare(String(b._t || "99")))
}

// ============================================================ kayıtlar (hiçbir şey silinmez)
let fm = null
const dir = () => { const d = fm.joinPath(fm.documentsDirectory(), "moodle-brief"); if (!fm.fileExists(d)) fm.createDirectory(d, true); return d }
const statePath = () => fm.joinPath(dir(), "state.json")
function loadState() {
  const empty = { seen: {}, extracted: {}, firstSeen: {}, missingSince: {}, archived: {}, replyCache: {}, lastFetch: 0,
    lastStruct: [], settings: { sendTime: "07:30", instantAnnouncements: true, updateCheck: true }, notifiedInstant: {} }
  for (const p of [statePath(), statePath() + ".bak"]) {
    try { if (fm.fileExists(p)) return Object.assign(empty, JSON.parse(fm.readString(p))) } catch (e) {}
  }
  return empty
}
function saveState(st) {
  const p = statePath()
  try { if (fm.fileExists(p)) { JSON.parse(fm.readString(p)); fm.writeString(p + ".bak", fm.readString(p)) } } catch (e) {}
  fm.writeString(p, JSON.stringify(st))
}
function archive(lines) {
  if (!lines.length) return
  const p = fm.joinPath(dir(), "archive.jsonl")
  const old = fm.fileExists(p) ? fm.readString(p) : ""
  fm.writeString(p, old + lines.map(l => JSON.stringify(l)).join("\n") + "\n")
}

// Güncellenen bir metinde NE değişti: eklenen satırlar; satırın sadece sonu uzadıysa eklenen kısım
function diffSummary(oldText, newText, limit = 110) {
  if (!oldText || !newText) return ""
  const skip = /^(Gönderen|Tarih|Son teslim|Açılış|Kapanış):/
  const oldLines = String(oldText).split("\n").map(l => l.trim()).filter(Boolean)
  const oldSet = new Set(oldLines), out = []
  for (const raw of String(newText).split("\n")) {
    const l = raw.trim()
    if (!l || oldSet.has(l) || skip.test(l)) continue
    const pre = oldLines.filter(o => l.startsWith(o)).sort((a, b) => b.length - a.length)[0] || ""
    let piece = pre.length >= 6 ? "+ " + l.slice(pre.length).trim() : l
    if (piece.length > 80) piece = piece.slice(0, 77) + "…"
    if (!out.includes(piece)) out.push(piece)
    if (out.length === 2) break
  }
  const res = out.join(" · ")
  return res.length <= limit ? res : res.slice(0, limit - 1) + "…"
}
let archiveCache = null, archiveVersions = null
function loadArchive() {
  if (archiveCache) return
  archiveCache = {}; archiveVersions = {}
  try {
    const p = fm.joinPath(dir(), "archive.jsonl")
    if (fm.fileExists(p)) for (const line of fm.readString(p).split("\n")) {
      if (!line) continue
      try { const r = JSON.parse(line); archiveCache[r.key] = r.text || ""; archiveVersions[r.key + "\u0000" + r.version] = r.text || "" } catch (e) {}
    }
  } catch (e) {}
}
function archiveLastText(key) {       // bir öğenin arşivdeki son (yani önceki) sürümünün metni
  loadArchive()
  return archiveCache[key]
}
function archiveVersionText(key, version) {   // bir öğenin arşivdeki belirli bir sürümünün metni (yoksa undefined)
  loadArchive()
  return archiveVersions[key + "\u0000" + version]
}
// Moodle bazen içeriğe dokunmadan sürümü değiştirir: teslim saati geçince "Closes:" etiketi "Closed:" olur, bir
// tartışmaya cevap gelince "değiştirilme zamanı" ilerler. Başlık ve metin (tarih satırlarında etiket hariç) aynıysa
// bu bir güncelleme değildir.
const RE_DATE_LABEL = /^[^\n]{1,60}?: (\d{4}-\d\d-\d\d \d\d:\d\d) \S+$/gm
const normText = t => String(t || "").replace(RE_DATE_LABEL, "$1").trim()
const sameContent = (oldTitle, oldText, title, text) => typeof oldText === "string" &&
  unescapeHtml(oldTitle || "") === (title || "") && normText(oldText) === normText(text)

// Moodle'dan gelen veriyi kayıtlara işle; yeni duyuruları ve notları döndür
function ingest(st, data) {
  const nowTs = Math.floor(now() / 1000), first = Object.keys(st.seen).length === 0
  const fresh = [], arch = [], rescan = st.rules !== RULES
  const gradeCourses = new Set(Object.keys(st.seen).filter(k => k.startsWith("grade:")).map(k => k.slice(0, k.lastIndexOf(":"))))
  archiveCache = null
  for (const it of data.items) {
    const prev = st.seen[it.key]
    if (prev !== it.version) {
      const old = st.extracted[it.key]
      if (prev && old && !it.file) {
        // kayıttaki metin 2000 karakterde kesilir; uzun metinlerde (ya da eski kayıtlarda) arşivdeki tam hâline bak
        const was = old.version === prev && typeof old.text === "string" && old.text.length < 2000 ? old.text : archiveVersionText(it.key, prev)
        if (sameContent(old.title, was, it.title, it.text)) {
          old.version = it.version                       // içerik aynı: haber değil, sadece yeni sürüm kayda geçer
          old.text = String(it.text || "").slice(0, 2000)
          if (rescan) old.events = freeExtract(it).events
          arch.push({ at: nowTs, key: it.key, version: it.version, course: it.course, kind: it.kind, title: it.title,
            time: it.time, text: it.text, events: old.events })
          st.seen[it.key] = it.version
          continue
        }
      }
      const ex = freeExtract(it)
      ex.course = it.course; ex.title = it.title; ex.kind = it.kind; ex.url = it.url
      ex.posted = it.time || 0; ex.version = it.version
      ex.text = it.file ? undefined : String(it.text || "").slice(0, 2000)
      ex.previous_versions = (old && old.previous_versions) || []
      if (old && old.version !== it.version) {
        ex.previous_versions.push({ version: old.version, events: old.events, replaced_at: nowTs })
        if (!it.file) {
          const chg = diffSummary(typeof old.text === "string" ? old.text : archiveLastText(it.key), it.text)
          if (chg) ex.change = chg
        }
      }
      st.extracted[it.key] = ex
      // bir derste not takibi yeni başladıysa eski notları "yeni" diye yağdırma
      const quiet = first || (it.key.startsWith("grade:") && !gradeCourses.has(it.key.slice(0, it.key.lastIndexOf(":"))) &&
        !(it.time && it.time > nowTs - 3 * 86400))
      st.firstSeen[it.key] = { t: quiet ? (it.time || 0) : nowTs, updated: Boolean(prev) && !first }
      arch.push({ at: nowTs, key: it.key, version: it.version, course: it.course, kind: it.kind, title: it.title,
        time: it.time, text: it.text, events: ex.events })
      if (!quiet && (it.kind.startsWith("duyuru") || it.kind === "not") &&
        !isStale({ kind: it.kind, posted: ex.posted, events: ex.events, updated: Boolean(prev), change: ex.change }, now())) fresh.push(it)
      st.seen[it.key] = it.version
    } else if (rescan && st.extracted[it.key] && !it.file) {
      st.extracted[it.key].events = freeExtract(it).events      // eski kuralların yanlış okuduğu tarihler düzelir
    }
  }
  st.rules = RULES
  archive(arch)
  // Moodle'dan kalkanlar: silinmez, 36 saattir yoksa (ve okuma hatası yoksa) gizlenir
  const live = new Set(data.items.map(i => i.key))
  const blocked = WARNINGS.some(w => /^(core_course_get_contents|mod_forum_|mod_assign_|mod_quiz_|core_calendar_)/.test(w) && !/disabled/i.test(w))
  for (const [k, ex] of Object.entries(st.extracted)) {
    if (live.has(k)) { delete st.missingSince[k]; ex.hidden = false }
    else if (!blocked && !arr(data.noHide).some(p => k.startsWith(p))) {
      st.missingSince[k] = st.missingSince[k] || nowTs
      if (nowTs - st.missingSince[k] > 36 * 3600) ex.hidden = true
    }
  }
  Object.assign(st.replyCache, data.replyCache)
  st.lastStruct = data.struct
  st.lastFetch = nowTs
  st.user = data.user
  return fresh
}

// ============================================================ brifing modeli
const KIND_TR = { "etkinlik (label)": "sayfa metni", "etkinlik (resource)": "dosya", "etkinlik (url)": "bağlantı",
  "etkinlik (assign)": "ödev", "etkinlik (quiz)": "quiz", "etkinlik (forum)": "forum", "etkinlik (folder)": "klasör",
  "etkinlik (page)": "sayfa", "etkinlik (feedback)": "anket", "etkinlik (choice)": "anket",
  "etkinlik (scheduler)": "randevu", "bölüm": "bölüm notu" }
const kindTr = k => KIND_TR[k] || String(k || "").replace(/^etkinlik \((.*)\)$/, "$1")
// Moodle "label" adını metnin ilk 50 karakterinden üretir; ilk anlamlı parçayı al
function shortTitle(n, limit = 70) {
  let t = n.title || ""
  if (n.kind === "etkinlik (label)") { const head = t.split(/[:(\n]/)[0].trim(); if (head.length >= 3) t = head }
  return t.length <= limit ? t : t.slice(0, limit - 1) + "…"
}
const NO_MERGE = ["duyuru", "duyuru cevabı", "forum", "forum cevabı", "mesaj", "bildirim", "not"]
const kindPrio = k => ["ödev", "quiz"].includes(k) ? 0 : (["dosya", "sayfa"].includes(k) || k.endsWith(" eki")) ? 1 : k === "takvim" ? 9 : 3
function baseTitle(n) {
  let t = unescapeHtml(n.title || "").split(" / ")[0]
  if (n.kind === "takvim") t = t.replace(/\s+(is due|is due to be graded|closes|opens|should be completed)\s*$/i, "")
  return t.replace(/\s+/g, " ").trim().toLowerCase()
}
// Aynı şeyin Moodle'daki kopyalarını tek satıra indirir: bir "resource" ile dosyası, bir ödevin
// etkinlik + ödev + takvim kayıtları. Aynı klasördeki farklı dosyalar ayrı kalır.
function dedupeNews(items) {
  const groups = {}
  for (const n of items) if (!NO_MERGE.includes(n.kind)) (groups[n.course + "|" + baseTitle(n)] = groups[n.course + "|" + baseTitle(n)] || []).push(n)
  const drop = new Set()
  for (const g of Object.values(groups)) {
    const best = g.reduce((a, b) => kindPrio(b.kind) < kindPrio(a.kind) ? b : a)
    for (const n of g) if (n.kind !== best.kind) { drop.add(n.key); if (n.change && !best.change) best.change = n.change }
  }
  return items.filter(n => !drop.has(n.key))
}
// ---- özet: duyurunun metni değil içindeki kritik bilgi; eskimiş haber ve tekrarlar yazılmaz
const ANN_KINDS = ["duyuru", "mesaj", "duyuru cevabı"]
const TEXT_KINDS = [...ANN_KINDS, "forum", "forum cevabı", "bildirim"]
const STALE_DAYS = 7
const whenTxt = (d, t, n) => (n === 0 ? "bugün" : n === 1 ? "yarın" : trDate(d)) + (t ? " " + t : "")
// Bir duyurudaki bugün ya da ileriye dönük tarihli olaylar: "Ara sınav bugün 14:00". Geçmiş tarihler yazılmaz.
function annFacts(events, asOf, limit = 3) {
  const rows = []
  for (const e of events || []) {
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) continue
    let d = fromYmd(e.date), t = e.time || null
    if (t === "00:00") { d = addDays(d, -1); t = "23:59" }
    const n = daysBetween(asOf, ymd(d))
    if (n >= 0) rows.push({ d, t, n, e })
  }
  rows.sort((a, b) => (a.d - b.d) || String(a.t || "99").localeCompare(String(b.t || "99")))
  const out = []
  for (const r of rows) {
    const typ = r.e.type || "other"
    const fact = TYPE_LABEL[typ] ? `${TYPE_LABEL[typ]} ${whenTxt(r.d, r.t, r.n)}` : cut(String(r.e.title || "").trim(), 90)
    if (fact && !out.includes(fact)) out.push(fact)
  }
  return out.slice(0, limit)
}
// Eski tarihli ve artık işe yaramayan haber: bir haftadan eski duyuru/ileti, içinde bugün ya da ileriye dönük
// tarih yok, metninde gösterilebilir bir değişiklik de yok. Kayıt silinmez, sadece özete girmez.
function isStale(n, asOf) {
  if (!TEXT_KINDS.includes(n.kind)) return false
  if (!n.posted || n.posted > asOf / 1000 - STALE_DAYS * 86400) return false
  if (n.updated && n.change) return false
  return annFacts(n.events, asOf, 1).length === 0
}
// Tarihli bilgi çıkmayan duyuru için tek kısa cümle (selam satırı atlanır)
// "Please note that …" gibi girişler atılır ki cümlenin asıl bilgisi (sınıf, saat) kesilmeden sığsın
const RE_LEAD_IN = new RegExp("^(?:(?:please|kindly)\\s+)*(?:note|be informed|be advised|be reminded|be aware)\\s+that\\s+" +
  "|^(?:this is|just)\\s+(?:a\\s+)?(?:(?:kind|quick|friendly|gentle)\\s+)?reminder\\s+that\\s+" +
  "|^(?:i|we)\\s+(?:would|want|wish)\\s+(?:like\\s+)?to\\s+(?:inform|remind|announce|let)\\s+(?:to\\s+)?(?:you\\s+)?" +
  "(?:all\\s+)?(?:know\\s+)?that\\s+", "i")
// Moodle'ın kalın/italik etiketlerinden kalan boşlukları toplar: "ET01 , in M100 ." -> "ET01, in M100."
const tidy = s => String(s || "").replace(/\s+/g, " ").replace(/\s+([,.;:!?])(?=\s|$)/g, "$1")
  .replace(/\s+\)/g, ")").replace(/\(\s+/g, "(").trim()
function gist(text, limit = 120) {
  const body = stripHello(String(text || "").replace(/^Gönderen:[\s\S]*?\n\n/, "")).trim()
  let first = body ? tidy(body.split(/(?<=[.!?])\s+|\n/)[0]) : ""
  const core = first.replace(RE_LEAD_IN, "")
  if (core && core !== first) first = core[0].toUpperCase() + core.slice(1)
  return cut(first, limit)
}
const FILLER = new Set(("the a an has have had been is are was were be to on in at for of and or it this that now please you your can " +
  "find see check uploaded posted announced available shared published added attached moodle page course " +
  "yüklendi yüklenmiştir paylaşıldı paylaşılmıştır duyuruldu eklendi eklenmiştir sisteme sayfasına bulabilirsiniz " +
  "ve ile için bir").split(" "))
// Cümle başlığın söylediğinden fazlasını söylüyor mu? "Seating Plan for MT2 has been uploaded to Moodle" başlığın
// tekrarıdır; "Office hours moved to TB215" değildir.
function addsToTitle(sentence, title) {
  const words = t => lowerEn(t).replace(/[^\p{L}\p{N}_ ]+/gu, " ").split(/\s+/).filter(Boolean)
  const have = new Set([...words(title), ...FILLER])
  return words(sentence).some(w => !have.has(w))
}
function annLines(a, asOf) {
  let facts = annFacts(a.events, asOf)
  if (a.updated && a.change) facts = ["✏️ " + cut(a.change, 90), ...facts]
  else if (!facts.length) { const g = gist(a.text); if (addsToTitle(g, a.title)) facts = [g] }
  return facts
}
// "Yeni içerik"ten tekrarlar çıkar: takvim kaydı zaten Bugün/Bu hafta'daysa, bildirim zaten gösterilen bir öğenin haberiyse
function filterOther(other, shown, asOf) {
  const titles = shown.filter(x => x.kind !== "bildirim").map(x => String(x.title || "").trim().toLowerCase()).filter(t => t.length >= 4)
  const annTitles = new Set(shown.filter(x => ANN_KINDS.includes(x.kind)).map(x => x.course + "|" + String(x.title || "").trim().toLowerCase()))
  return other.filter(n => {
    if (annTitles.has(n.course + "|" + baseTitle(n))) return false      // duyurusu zaten yazılan dosya/etkinlik
    if (n.kind === "takvim") {
      const ds = String(n.text || "").slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(ds) && daysBetween(asOf, ds) <= 7) return false
    }
    if (n.kind === "bildirim") { const low = String(n.title || "").toLowerCase(); if (titles.some(t => low.includes(t))) return false }
    return true
  })
}
// Yeni dosya/etkinlikleri ders başına tek satıra indirir: "5 dosya (L7, L8, L9, +2) · quiz: Quiz 3"
function groupOther(items, maxLines = 6) {
  const bases = {}
  for (const n of items) { const k = n.course + "|" + baseTitle(n); bases[k] = (bases[k] || 0) + 1 }
  const by = new Map()
  for (const n of items) {
    let title = shortTitle(n, 40)
    const full = String(n.title || "")
    if (full.includes(" / ") && bases[n.course + "|" + baseTitle(n)] > 1) title = cut(full.split(" / ").slice(1).join(" / "), 40)
    else if (title.includes(" / ")) title = cut(title.split(" / ")[0], 40)
    if (n.kind === "takvim") {
      const ds = String(n.text || "").slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) { const d = fromYmd(ds); title += ` (${d.getDate()} ${AY_KISA[d.getMonth()]})` }
    }
    if (n.updated) title += n.change ? ` (✏️ ${cut(n.change, 60)})` : " ✏️"
    if (!by.has(n.course)) by.set(n.course, new Map())
    const labs = by.get(n.course), lab = kindTr(n.kind)
    if (!labs.has(lab)) labs.set(lab, [])
    labs.get(lab).push(title)
  }
  const lines = []
  for (const [course, labs] of by) {
    const parts = []
    for (const [lab, ts] of labs) parts.push(lab.toLowerCase() === course.toLowerCase()
      ? ts.slice(0, 3).join(", ") + (ts.length > 3 ? `, +${ts.length - 3}` : "")          // "Bildirim bildirim:" demeyelim
      : ts.length <= 3 ? `${lab}: ${ts.join(", ")}` : `${ts.length} ${lab} (${ts.slice(0, 3).join(", ")}, +${ts.length - 3})`)
    lines.push({ course, text: parts.join(" · ") })
  }
  return lines.length > maxLines ? [...lines.slice(0, maxLines), { course: "", text: `… ve ${lines.length - maxLines} ders daha` }] : lines
}
function buildModel(st, asOf) {
  const doc = []
  for (const [k, ex] of Object.entries(st.extracted)) {
    if (ex.hidden) continue
    for (const e of ex.events || []) doc.push({ ...e, course: ex.course, posted: ex.posted || 0, url: ex.url || "", item: k, source: ex.title || "" })
  }
  const evs = mergedEvents(st.lastStruct || [], supersede(doc), asOf)
  const todays = evs.filter(e => e._n === 0)
  const exams = evs.filter(e => isExam(e) && !e._past).slice(0, 3)
  const week = evs.filter(e => e._n >= 1 && e._n <= 7 && !exams.includes(e))
  const since = Math.floor(asOf / 1000) - 24 * 3600
  const news = Object.entries(st.firstSeen).filter(([k, f]) => f.t > since && st.extracted[k] && !st.extracted[k].hidden)
    .map(([k, f]) => ({ key: k, ...st.extracted[k], updated: f.updated, t: f.t }))
  const seenNews = new Set(), uniq = []
  for (const n of news.sort((a, b) => b.t - a.t)) {
    if (isStale(n, asOf)) continue
    const sig = n.course + "|" + (n.title || "").toLowerCase() + "|" + hash(n.text || n.key).slice(0, 8)
    if (!seenNews.has(sig)) { seenNews.add(sig); uniq.push(n) }
  }
  const merged = dedupeNews(uniq)
  const ann = merged.filter(n => ANN_KINDS.includes(n.kind))
  const grades = merged.filter(n => n.kind === "not")
  const other = filterOther(merged.filter(n => !ann.includes(n) && !grades.includes(n)), merged, asOf)
  return { asOf, todays, exams, week, ann, grades, other, all: evs, user: st.user }
}
function label(e) {
  const title = (e.title || "").trim(), typ = e.type || ""
  if (e.certainty === "approximate" && TYPE_LABEL[typ]) return title.length <= 45 ? `${TYPE_LABEL[typ]} — ${title}` : TYPE_LABEL[typ]
  return title
}
const mark = e => e.certainty === "approximate" ? " ❔" : ""
const cut = (s, n) => s.length <= n ? s : s.slice(0, n - 1).replace(/[\s(,.·:;-]+$/, "") + "…"
// kısaltırken sondaki "(kapanış)" gibi etiketi korur: "Self-study Material 2 R… (kapanış)"
function cutLabel(s, n) {
  const m = s.match(/^(.*\S)(\s\([^()]{1,12}\))$/)
  return m && s.length > n ? cut(m[1], n - m[2].length) + m[2] : cut(s, n)
}
const evLine = (e, withDate = true) =>
  `${e.course} ${label(e)}${mark(e)}${withDate ? ` · ${trDate(e._d)}` : ""}${e._t ? " " + e._t : ""}${withDate ? ` (${left(e._n)})` : ""}`

// Bildirim metni (kısa)
function notificationText(m) {
  const lines = []
  // kilit ekranında ~4 satır görünür: saat başta, başlık kısa, en çok 3 iş; saati geçenler yazılmaz
  const live = m.todays.filter(e => !e._past), open = live.filter(e => !e.done)
  lines.push(open.length ? "📌 Bugün: " + open.slice(0, 3).map(e => `${e._t ? e._t + " " : ""}${e.course} ${cutLabel(label(e), 34)}`).join(" · ") +
      (open.length > 3 ? ` · +${open.length - 3}` : "")
    : live.length ? "📌 Bugünkü teslimler tamam ✓" : "")
  if (m.exams.length) {
    const e = m.exams[0]
    lines.push(`🎯 ${e.course} ${label(e)} · ${trDate(e._d)} (${left(e._n)})${e.changed_from ? " ⚠️ tarih değişti" : ""}`)
  }
  const wk = m.week.filter(e => !e.done)
  if (wk.length) lines.push(`📅 Bu hafta ${wk.length} teslim/etkinlik`)
  if (m.grades.length) lines.push(`📊 Yeni not: ` + m.grades.slice(0, 2).map(g => `${g.course} ${g.title} ${String(g.text || "").split("\n")[0]}`).join(" · "))
  if (m.ann.length) lines.push("📣 " + m.ann.slice(0, 2).map(a => {
    const f = annFacts(a.events, m.asOf, 1)[0]
    return `${a.course} ${cut(a.title || "", 40)}${f && f.length <= 40 ? " → " + f : ""}`
  }).join(" · ") + (m.ann.length > 2 ? ` · +${m.ann.length - 2}` : ""))
  if (m.other.length) lines.push(`🆕 ${m.other.length} yeni içerik`)
  // bir şey yoksa satırı da yok; hiçbir şey yoksa tek cümle
  return lines.filter(Boolean).join("\n") || "Bugün için kayıtlı bir şey ve yeni içerik yok."
}

// Uygulama içi tam brifing (HTML)
function briefHtml(m) {
  const S = (t, body) => `<h2>${t}</h2>${body}`
  const li = arr => arr.length ? `<ul>${arr.join("")}</ul>` : ""
  const evLi = (e, withDate) => `<li><b>${esc(e.course)}</b> ${esc(label(e))}${mark(e)}` +
    `${withDate ? ` <span class=d>· ${esc(trDate(e._d))}${e._t ? " " + e._t : ""} (${left(e._n)})</span>` : (e._t ? ` <span class=d>${e._t}</span>` : "")}` +
    `${e.done ? ` <span class=ok>✓ teslim edildi</span>` : ""}${e._past && !e.done ? ` <span class=d>(saati geçti)</span>` : ""}` +
    `${e.certainty === "approximate" && e.url ? ` <a class=src href="${esc(e.url)}">duyuru ›</a>` : ""}` +
    `${e.certainty === "approximate" && (e.title || "").length > 45 ? `<div class=q>“${esc(e.title)}”</div>` : ""}` +
    `${e.changed_from ? `<div class=w>⚠️ tarih değişti (eskisi ${esc(trDate(fromYmd(e.changed_from)))})</div>` : ""}` +
    `${e.weekday_mismatch ? `<div class=w>⚠️ gün adı tarihle uyuşmuyor, kontrol et</div>` : ""}` +
    `${(e.text_dates || []).length ? `<div class=w>⚠️ açıklamasında ${esc(e.text_dates.slice().sort().map(x => dayMon(fromYmd(x))).join(", "))} yazıyor, ` +
      `Moodle'da ${esc(dayMon(e._d))} — kontrol et</div>` : ""}</li>`
  let weekHtml = ""
  let cur = null
  for (const e of m.week) {
    const h = `${GUN[e._d.getDay()]} ${e._d.getDate()} ${AY_KISA[e._d.getMonth()]} (${left(e._n)})`
    if (h !== cur) { weekHtml += `${cur ? "</ul>" : ""}<div class=day>${esc(h)}</div><ul>`; cur = h }
    weekHtml += evLi(e, false)
  }
  if (cur) weekHtml += "</ul>"
  // duyurunun metni değil, içindeki kritik bilgi; tamamı için başlığa dokunulur
  const annHtml = m.ann.slice(0, 12).map(a => {
    const title = esc(cut(a.title || "", 70))
    return `<div class=ann><b>${esc(a.course)} · ${a.url ? `<a href="${esc(a.url)}">${title}</a>` : title}</b>${a.updated ? " <i>(güncellendi)</i>" : ""}` +
      annLines(a, m.asOf).map(f => `<div class=f>→ ${esc(f)}</div>`).join("") + `</div>`
  }).join("") + (m.ann.length > 12 ? `<div class=empty>… ve ${m.ann.length - 12} duyuru daha</div>` : "")
  const gradeHtml = li(m.grades.slice(0, 15).map(g => {
    const lines = String(g.text || "").split("\n"), fb = lines.slice(1).join(" ").replace(/\s+/g, " ").trim()
    return `<li><b>${esc(g.course)}</b> ${esc((g.title || "").slice(0, 60))}: <b>${esc(lines[0])}</b>${g.updated ? " <i>(değişti)</i>" : ""}` +
      `${fb ? `<div class=d>${esc(cut(fb, 100))}</div>` : ""}</li>`
  }))
  const otherHtml = li(groupOther(m.other).map(g => `<li>${g.course ? `<b>${esc(g.course)}</b> ` : ""}${esc(g.text)}</li>`))
  const approx = [...m.todays, ...m.exams, ...m.week].some(e => e.certainty === "approximate")
  const nothing = !m.todays.length && !m.exams.length && !weekHtml && !m.grades.length && !m.ann.length && !m.other.length
  const d = m.asOf
  return `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}body{font-family:-apple-system;margin:0;padding:18px 18px 40px;background:#fff;color:#111;line-height:1.4}
@media(prefers-color-scheme:dark){body{background:#000;color:#eee}.ann{background:#1c1c1e!important}.d,.foot{color:#999!important}}
h1{font-size:26px;margin:4px 0 2px}h2{font-size:17px;margin:22px 0 6px}ul{padding-left:18px;margin:4px 0}li{margin:4px 0}
.d{color:#666}.w{color:#d97706;font-size:14px}.day{font-weight:600;margin-top:8px}.ann{background:#f2f2f7;border-radius:12px;padding:10px 12px;margin:8px 0}
.upd{background:#0a84ff;color:#fff;border-radius:10px;padding:8px 12px;margin-bottom:10px;font-size:15px}.upd a{color:#fff;font-weight:600}
.ok{color:#1a7f45;font-size:14px}.q{color:#777;font-size:14px;font-style:italic}.src{font-size:14px;white-space:nowrap}
.ann .f{margin-top:3px;font-size:15px}.ann a{text-decoration:none}.empty{color:#888}.foot{color:#888;font-size:13px;margin-top:24px}a{color:#0a84ff}
</style></head><body>
<h1>☀️ ${d.getDate()} ${AY_KISA[d.getMonth()]} ${GUN[d.getDay()]}</h1>
${m.todays.length ? S("📌 Bugün", li(m.todays.map(e => evLi(e, false)))) : ""}
${m.exams.length ? S("🎯 Sınavlar", li(m.exams.map(e => evLi(e, true)))) : ""}
${weekHtml ? S("📅 Bu hafta", weekHtml) : ""}
${m.grades.length ? S("📊 Notlar", gradeHtml) : ""}
${m.ann.length ? S("📣 Duyurular", annHtml) : ""}
${m.other.length ? S("🆕 Yeni içerik", otherHtml) : ""}
${nothing ? `<div class=empty style="margin-top:18px">Bugün için kayıtlı bir şey ve yeni içerik yok.</div>` : ""}
<div class=foot>${approx ? "❔ = duyuru metninden çıkarıldı, teyit et<br>" : ""}Moodle Brief ${VERSION} · veriler sadece bu telefonda</div>
</body></html>`
}

// ============================================================ bildirimler
function nextSendDate(st, from) {
  const [hh, mm] = (st.settings.sendTime || "07:30").split(":").map(Number)
  let t = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hh, mm)
  if (t <= from || st.deliveredDay === ymd(from) && t.getDate() === from.getDate()) t = addDays(t, 1)
  return t
}
async function scheduleMorning(st, deliverNow = false) {
  const at = deliverNow ? now() : nextSendDate(st, now())
  const m = buildModel(st, at)
  const n = new Notification()
  n.identifier = NOTIF_MORNING
  n.threadIdentifier = "moodlebrief"
  n.title = `☀️ Moodle · ${trDate(at)}`
  n.body = notificationText(m)
  n.openURL = URLScheme.forRunningScript() + "?view=brief"
  if (!deliverNow) n.setTriggerDate(at)
  await n.schedule()
  if (deliverNow) st.deliveredDay = ymd(at)
  st.nextMorning = at.getTime()
}
// Teslim edilmemiş, saati belli (Moodle'ın kendi kaydı olan) işler için bitimine 3 saat kala hatırlatma.
// Gece 23:00–08:00'e denk gelirse bir önceki akşam 22:00'ye alınır. Aynı iş için bir kez çalar.
function reminderTime(due) {
  let at = new Date(due.getTime() - 3 * 3600 * 1000)
  const h = at.getHours()
  if (h >= 23 || h < 8) {
    const b = h < 8 ? addDays(at, -1) : at
    at = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 22, 0)
  }
  return at
}
// Hatırlatmanın türü: "due" = son teslim/kapanış, "open" = açılış (hatırlatılmaz), "start" = saatinde başlayan etkinlik
function remKind(e) {
  const title = e.title || "", typ = e.type || ""
  if (/açılış/.test(title) || /açılış/.test(typ)) return "open"
  if (e.source !== "moodle takvim") return "due"
  const et = String(e.etype || "").toLowerCase()
  if (/^open/.test(et) || /\sopens$/i.test(title)) return "open"
  if (/close|due|expectcompletion/.test(et) || /\b(?:is due|due|closes|should be completed)\b|son gün|sona er|kapan|teslim/i.test(title)) return "due"
  return "start"
}
async function scheduleReminders(st, evs) {
  const old = st.reminders || {}, keep = {}, nowMs = now().getTime()
  if (st.settings.deadlineReminders !== false) {
    for (const e of evs) {
      if (e.certainty !== "exact" || !e.time || e.done) continue
      const kind = remKind(e)
      if (kind === "open") continue
      const [hh, mm] = e.time.split(":").map(Number), d0 = fromYmd(e.date)
      const due = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), hh, mm)
      const ms = due.getTime() - nowMs
      if (ms <= 20 * 60 * 1000 || ms > 48 * 3600 * 1000) continue
      const id = NOTIF_DUE + hash(e.course, e.title, e.date, e.time)
      if (old[id] && old[id].at <= nowMs) { keep[id] = old[id]; continue }      // zaten çaldı
      let at = reminderTime(due)
      if (at.getTime() <= nowMs) at = new Date(nowMs + 60 * 1000)               // pencerenin içinde öğrendiysek hemen
      const dn = daysBetween(at, ymd(e._d))
      const n = new Notification()
      n.identifier = id
      n.threadIdentifier = "moodlebrief"
      // zaman başlıkta (kesilmez), işin tam adı gövdede; görüşme/etkinlik için "son" denmez
      n.title = `⏰ ${e.course} · ${dn <= 0 ? "Bugün" : dn === 1 ? "Yarın" : trDate(e._d)} ${e._t}${kind === "due" ? " son" : ""}`
      n.body = e.title
      n.openURL = URLScheme.forRunningScript() + "?view=brief"
      n.setTriggerDate(at)
      await n.schedule()
      keep[id] = { at: at.getTime() }
    }
  }
  // artık gerekmeyen (teslim edildi / tarihi değişti / kapatıldı) bekleyen hatırlatmaları iptal et
  const stale = Object.keys(old).filter(id => !keep[id] && old[id].at > nowMs)
  if (stale.length) Notification.removePending(stale)
  st.reminders = keep
}
// "Dear all," / "Merhaba arkadaşlar," gibi tek başına selam satırını atar ki bildirimde asıl cümle görünsün
const stripHello = s => String(s || "").replace(
  /^\s*(?:dear|hello|hi|merhabalar|merhaba|sevgili|değerli|selamlar|selam|sayın)(?![\p{L}])(?:[ \t]+[^\s,!:.]+){0,4}[ \t]*[,!:.]?[ \t]*\n+/iu, "")
async function instantNotify(st, fresh) {
  if (!st.settings.instantAnnouncements) return
  const sent = st.notifiedInstant
  const todo = fresh.filter(it => sent[it.key] !== it.version)
  for (const it of todo.slice(0, 3)) {
    const upd = Boolean(st.firstSeen[it.key] && st.firstSeen[it.key].updated)
    const chg = upd && st.extracted[it.key] ? st.extracted[it.key].change : ""
    const n = new Notification()
    n.threadIdentifier = "moodlebrief"
    n.title = `${it.kind === "not" ? (upd ? "📊 Not değişti" : "📊 Yeni not") : (upd ? "📣 Güncellendi:" : "📣")} ${it.course} · ${it.title}`
    n.body = ((chg ? `✏️ ${chg}\n` : "") + stripHello(String(it.text || "").replace(/^Gönderen:[\s\S]*?\n\n/, "")).trim()).slice(0, 240)
    n.openURL = URLScheme.forRunningScript() + "?view=brief"
    await n.schedule()
    sent[it.key] = it.version
  }
  // aynı anda 3'ten fazla yeni duyuru/not geldiyse kalanlar tek bildirimde (hiçbiri sessizce atlanmaz)
  const rest = todo.slice(3)
  if (rest.length) {
    const n = new Notification()
    n.threadIdentifier = "moodlebrief"
    n.title = `📬 ${rest.length} yeni duyuru/not daha`
    n.body = cut(rest.map(it => `${it.course} · ${it.title}`).join("\n"), 240)
    n.openURL = URLScheme.forRunningScript() + "?view=brief"
    await n.schedule()
    rest.forEach(it => { sent[it.key] = it.version })
  }
}

// ============================================================ sürüm kontrolü
// "1.10.0" > "1.9.3": parça parça sayısal karşılaştırma
function cmpVer(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".")
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
// Günde bir kez kurulum sayfasındaki sürüm dosyasına bakar; yenisi varsa bir kez bildirir.
// Giden tek şey isteğin kendisidir: ders/kullanıcı verisi gönderilmez, karşı taraf GitHub'ın statik
// sunucusudur. Ulaşılamazsa sessizce geçer; brifing her hâlükârda çalışır.
async function checkUpdate(st) {
  if (st.settings.updateCheck === false) return null
  // kullanıcı betiği güncellediyse kayıttaki "yeni sürüm var" bilgisi hemen düşer (yoksa şerit 20 saat daha kalırdı)
  if (st.updateReady && cmpVer(VERSION, st.updateReady.version) >= 0) delete st.updateReady
  const nowMs = now().getTime()
  if (st.updateCheckedAt && nowMs - st.updateCheckedAt < 20 * 3600 * 1000) return st.updateReady || null
  let info
  try { info = await httpGet(UPDATE_URL) }
  catch (e) { st.updateCheckedAt = nowMs - 19 * 3600 * 1000; return st.updateReady || null }   // ulaşılamadı: 1 saat sonra yine dene
  st.updateCheckedAt = nowMs
  const v = info && typeof info.version === "string" ? info.version.trim() : ""
  if (!/^\d+(?:\.\d+){0,3}$/.test(v) || cmpVer(VERSION, v) >= 0) { delete st.updateReady; return null }
  st.updateReady = { version: v, notes: String((info && info.notes) || "").replace(/\s+/g, " ").trim().slice(0, 200) }
  if (st.updateNotified !== v) {
    const n = new Notification()
    n.identifier = NOTIF_UPDATE
    n.threadIdentifier = "moodlebrief"
    n.title = `⬆️ Moodle Brief ${v} çıktı (sende ${VERSION})`
    n.body = (st.updateReady.notes ? st.updateReady.notes + "\n" : "") + "Kurulum sayfasını aç, kodu kopyalayıp betiğin üstüne yapıştır."
    n.openURL = INSTALL_URL
    const at = now()                       // widget gece de çalışır: 23:00–08:00 arasında bulunduysa sabah 09:00'da bildir
    if (at.getHours() >= 23 || at.getHours() < 8) {
      const d = at.getHours() >= 23 ? addDays(at, 1) : at
      n.setTriggerDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0))
    }
    await n.schedule()
    st.updateNotified = v                  // ancak bildirim kurulduysa "bildirildi" say
  }
  return st.updateReady
}

// ============================================================ giriş (Busign / okul hesabı)
const DONE_HTML = `<html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>
body{font-family:-apple-system;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center}
h1{font-size:30px}p{color:#aaa;font-size:18px}</style></head><body><div><h1>✅ Bağlandı</h1><p>Sol üstteki <b>Close</b>'a bas.</p></div></body></html>`
async function ssoLogin(base) {
  const passport = String(Math.floor(Math.random() * 1e9)) + String(Date.now() % 1e6)
  let captured = null
  const wv = new WebView()
  wv.shouldAllowRequest = (req) => {
    const u = String(req.url || "")
    if (/^moodlemobile:\/\//i.test(u)) {
      captured = u
      Timer.schedule(50, false, () => { wv.loadHTML(DONE_HTML) })
      return false
    }
    return true
  }
  await wv.loadURL(`${base}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`)
  await wv.present(true)
  if (!captured) return null
  const m = captured.match(/token=([A-Za-z0-9+\/=_-]+)/)
  if (!m) return null
  const parts = Data.fromBase64String(m[1].replace(/-/g, "+").replace(/_/g, "/")).toRawString().split(":::")
  return parts.length >= 2 && /^[a-f0-9]{32}$/.test(parts[1]) ? parts[1] : null
}
async function alert(title, message, buttons = ["Tamam"], cancel = null) {
  const a = new Alert()
  a.title = title
  a.message = message
  buttons.forEach(b => a.addAction(b))
  if (cancel) a.addCancelAction(cancel)
  return await a.present()
}
async function onboarding(base) {
  const c = await alert("Moodle Brief'e hoş geldin 👋",
    "Her sabah bugünkü teslimlerin, haftanın olayları, en yakın sınavın ve yeni duyurular telefonuna bildirim olarak gelir.\n\n" +
    "Bağlanmak için açılacak sayfada okul hesabınla (Busign) giriş yap, sonra Close'a bas.\n\n" +
    "🔒 Şifreni betik görmez. Hiçbir veri bu telefondan çıkmaz.", ["Okul hesabınla bağlan"], "Vazgeç")
  if (c === -1) return null
  const token = await ssoLogin(base)
  if (!token) {
    await alert("Bağlanamadı", "Giriş tamamlanmadı ya da Moodle anahtar göndermedi. Tekrar dene; sorun sürerse Busign ile giriş yaptığından emin ol.")
    return null
  }
  Keychain.set(KC_TOKEN, token)
  Keychain.set(KC_URL, base)
  return token
}

// ============================================================ widget
function widget(m, st, error) {
  const w = new ListWidget()
  w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#111114"))
  const fam = config.widgetFamily || "medium"
  const head = w.addText(error ? "Moodle Brief ⚠️" : "🎓 Moodle")
  head.font = Font.boldSystemFont(13)
  head.textColor = Color.dynamic(new Color("#0a84ff"), new Color("#64a8ff"))
  w.addSpacer(4)
  const line = (t, size = 12, bold = false, dim = false) => {
    const x = w.addText(t)
    x.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size)
    x.textColor = dim ? Color.gray() : Color.dynamic(Color.black(), Color.white())
    x.lineLimit = 1
    x.minimumScaleFactor = 0.8
  }
  if (error) { line(error, 11, false, true); return w }
  const max = fam === "small" ? 2 : fam === "large" ? 6 : 3
  if (m.exams.length) {
    m.exams.slice(0, max).forEach(e => line(`${e.course} ${TYPE_LABEL[e.type] || e.title} · ${left(e._n)}`, fam === "small" ? 12 : 13, true))
  } else line("Kayıtlı sınav yok", 12, false, true)
  const pending = [...m.todays, ...m.week].filter(e => !e.done && !e._past && !m.exams.includes(e))
  if (fam === "small") {
    w.addSpacer(4)
    if (pending.length) line(`${left(pending[0]._n)}: ${pending[0].course} ${label(pending[0])}`, 11)
    if (m.grades.length) line(`📊 ${m.grades.length} yeni not`, 11, true)
    if (m.ann.length) line(`📣 ${m.ann.length} yeni duyuru`, 11, true)
  } else {
    w.addSpacer(4)
    const wk = pending.slice(0, fam === "large" ? 6 : 2)
    wk.forEach(e => line(`${trDate(e._d)} · ${e.course} ${label(e)}`, 11))
    if (m.grades.length) line(`📊 ${m.grades[0].course} ${m.grades[0].title}: ${String(m.grades[0].text || "").split("\n")[0]}`, 11, true)
    if (m.ann.length) line(`📣 ${m.ann.length} yeni duyuru`, 11, true)
  }
  w.addSpacer()
  const f = w.addText(`güncellendi ${hm(new Date(st.lastFetch * 1000))}`)
  f.font = Font.systemFont(9)
  f.textColor = Color.gray()
  w.url = URLScheme.forRunningScript() + "?view=brief"
  w.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000)
  return w
}

// ============================================================ ana akış
async function refresh(st, base, token, force) {
  const nowTs = Math.floor(now() / 1000)
  if (!force && nowTs - (st.lastFetch || 0) < 50 * 60) return []      // pil dostu: en sık saatte bir
  const data = await collect(base, token, st.replyCache || {})
  return ingest(st, data)
}

async function main() {
  fm = FileManager.local()
  const st = loadState()
  const base = Keychain.contains(KC_URL) ? Keychain.get(KC_URL) : DEFAULT_URL
  let token = Keychain.contains(KC_TOKEN) ? Keychain.get(KC_TOKEN) : null
  const q = (args && args.queryParameters) || {}
  const inWidget = config.runsInWidget
  const inShortcut = config.runsWithSiri && !config.runsInApp

  if (!token) {
    if (inWidget) { Script.setWidget(widget(null, st, "Kurulum için dokun")); return }
    token = await onboarding(base)
    if (!token) return
  }

  let error = null, fresh = []
  try {
    fresh = await refresh(st, base, token, config.runsInApp || inShortcut || q.view === "brief")
  } catch (e) {
    if (e instanceof TokenError) {
      error = "Moodle bağlantısı koptu — dokun ve tekrar bağlan"
      if (!inWidget && !inShortcut) {
        Keychain.remove(KC_TOKEN)
        token = await onboarding(base)
        if (token) { try { fresh = await refresh(st, base, token, true); error = null } catch (e2) { error = String(e2.message || e2) } }
      } else if (st.lastTokenWarn !== ymd(now())) {
        const n = new Notification()
        n.title = "⚠️ Moodle Brief bağlantısı koptu"
        n.body = "Dokun ve okul hesabınla tekrar bağlan."
        n.openURL = URLScheme.forRunningScript()
        await n.schedule()
        st.lastTokenWarn = ymd(now())
      }
    } else {
      error = (e instanceof TransientError) ? "Moodle'a ulaşılamadı, eski veriler gösteriliyor" : String(e.message || e)
    }
  }

  await instantNotify(st, fresh)
  let upd = null
  try { upd = await checkUpdate(st) } catch (e) {}
  // Kestirmeler otomasyonundan sabah saatinde çalıştıysa: brifingi hemen gönder
  const [hh, mm] = st.settings.sendTime.split(":").map(Number)
  const sendToday = new Date(now().getFullYear(), now().getMonth(), now().getDate(), hh, mm)
  const nearSend = Math.abs(now() - sendToday) < 45 * 60 * 1000
  if (inShortcut && nearSend && st.deliveredDay !== ymd(now())) {
    Notification.removePending([NOTIF_MORNING])
    await scheduleMorning(st, true)
  }
  await scheduleMorning(st, false)      // bir sonraki sabahı güncel veriyle (yeniden) planla
  const model = buildModel(st, now())
  try { await scheduleReminders(st, model.all) } catch (e) {}
  saveState(st)

  if (inWidget) { Script.setWidget(widget(model, st, error)); return }
  if (inShortcut) { Script.setShortcutOutput(notificationText(model)); return }

  // Uygulama içinde: tam brifing
  const wv = new WebView()
  let wantSettings = false
  wv.shouldAllowRequest = (req) => {
    const u = String(req.url || "")
    if (u.startsWith("moodlebrief://settings")) { wantSettings = true; Timer.schedule(50, false, () => wv.loadHTML(DONE_SETTINGS)); return false }
    if (/^https?:\/\//i.test(u)) { Safari.open(u); return false }
    return true
  }
  let html = briefHtml(model)
  if (upd) html = html.replace("<h1>", `<div class=upd>⬆️ Yeni sürüm ${esc(upd.version)} var — <a href="${INSTALL_URL}">kurulum sayfasını aç</a>` +
    `${upd.notes ? `<div style="font-size:13px;opacity:.9">${esc(upd.notes)}</div>` : ""}</div><h1>`)
  if (error) html = html.replace("<h1>", `<div class=w style="margin-bottom:8px">⚠️ ${esc(error)}</div><h1>`)
  html = html.replace("</body>", `<p class=foot><a href="moodlebrief://settings">⚙️ Ayarlar</a> · sonraki sabah bildirimi: ${st.nextMorning ? esc(trDate(new Date(st.nextMorning)) + " " + hm(new Date(st.nextMorning))) : "-"}</p></body>`)
  await wv.loadHTML(html)
  await wv.present(true)
  if (wantSettings) await settings(st, base)
}
const DONE_SETTINGS = `<html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center}</style></head><body><p>Ayarlar için sol üstteki <b>Close</b>'a bas.</p></body></html>`

async function settings(st, base) {
  const remOn = st.settings.deadlineReminders !== false, updOn = st.settings.updateCheck !== false
  const c = await alert("Ayarlar", `Sabah bildirimi: ${st.settings.sendTime}\nAnlık duyuru bildirimi: ${st.settings.instantAnnouncements ? "açık" : "kapalı"}` +
    `\nTeslim hatırlatması (3 saat kala): ${remOn ? "açık" : "kapalı"}` +
    `\nYeni sürüm uyarısı: ${updOn ? "açık" : "kapalı"}\n\nSürüm ${VERSION}`,
    ["Bildirim saatini değiştir", st.settings.instantAnnouncements ? "Anlık duyuruları kapat" : "Anlık duyuruları aç",
      "Sabah bildirimini tam saatinde almak (Kestirmeler)", "Moodle bağlantısını yenile",
      remOn ? "Teslim hatırlatmalarını kapat" : "Teslim hatırlatmalarını aç",
      updOn ? "Yeni sürüm uyarısını kapat" : "Yeni sürüm uyarısını aç"], "Kapat")
  if (c === 0) {
    const a = new Alert()
    a.title = "Bildirim saati"
    a.message = "SS:DD biçiminde (örn. 07:30)"
    a.addTextField("07:30", st.settings.sendTime)
    a.addAction("Kaydet")
    a.addCancelAction("Vazgeç")
    if (await a.present() === 0) {
      const v = a.textFieldValue(0).trim()
      if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) { st.settings.sendTime = v.padStart(5, "0"); Notification.removePending([NOTIF_MORNING]); await scheduleMorning(st, false) }
    }
  } else if (c === 1) {
    st.settings.instantAnnouncements = !st.settings.instantAnnouncements
  } else if (c === 2) {
    await alert("Tam saatinde, en güncel brifing",
      "Bildirim her durumda gelir ama içeriği en son yenilemedeki veridir. Ana ekrana Moodle Brief widget'ını eklemek onu gün içinde güncel tutar.\n\n" +
      "Tam saatinde taze veri için (bir kez, 1 dk):\nKestirmeler → Otomasyon → + → Günün Saati → " + st.settings.sendTime +
      ", Her Gün, Hemen Çalıştır → Yeni Boş Otomasyon → Eylem Ekle → Scriptable 'Run Script' → Moodle Brief.")
  } else if (c === 3) {
    Keychain.remove(KC_TOKEN)
    const t = await onboarding(base)
    if (t) await alert("Tamam", "Bağlantı yenilendi.")
  } else if (c === 4) {
    st.settings.deadlineReminders = !remOn
    try { await scheduleReminders(st, buildModel(st, now()).all) } catch (e) {}
  } else if (c === 5) {
    st.settings.updateCheck = !updOn
    if (st.settings.updateCheck) {
      delete st.updateCheckedAt                                 // açınca hemen bir kez bak
      try { await checkUpdate(st) } catch (e) {}
    } else {
      Notification.removePending([NOTIF_UPDATE])
    }
  }
  saveState(st)
}

// Testler bu dosyayı __TEST__ ile yükler ve iç fonksiyonları alır
if (typeof __TEST__ !== "undefined") {
  __EXPORTS__.api = { regexDates, freeExtract, supersede, mergedEvents, buildModel, ingest, notificationText, briefHtml,
    shortCourse, examSlot, isExam, collect, setNow: f => { nowFn = f }, setPost: f => { httpPost = f }, setGet: f => { httpGet = f }, setFm: f => { fm = f },
    loadState, saveState, nextSendDate, reminderTime, scheduleReminders, instantNotify, remKind, stripHello, checkUpdate, cmpVer, settings, VERSION, annFacts, isStale, gist, addsToTitle, filterOther, groupOther, widget, WARNINGS, htmlToText, unescapeHtml, diffSummary, dedupeNews, fmtGrade, kindTr, gradesFromTable }
} else {
  await main()
  Script.complete()
}
