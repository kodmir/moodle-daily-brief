// Helper for tests/parity/run.py: answers the cases in argv[2] with the iPhone script. now = argv[3] (ms)
const fs = require("fs"), path = require("path")
const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "moodle-brief.js"), "utf8")
global.Notification = class { setTriggerDate() {} async schedule() {} static removePending() {} }
global.URLScheme = { forRunningScript: () => "x" }
;(async () => {
  const EXP = {}
  await new Function("__TEST__", "__EXPORTS__", "return (async () => {" + src + "})()")(true, EXP)
  const A = EXP.api, now = +process.argv[3]
  A.setNow(() => new Date(now))
  const out = []
  for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
    if (!line) continue
    const { fn, args } = JSON.parse(line)
    try {
      let r
      if (fn === "dates") r = A.regexDates(args[0], args[1], args[2], args[3] || "").map(e => [e.type, e.date, e.time, e.certainty, !!e.weekday_mismatch, e.title, e.place || null, e.seats || null])
      else if (fn === "gist") r = A.gist(args[0])
      else if (fn === "isExam") r = A.isExam(args[0])
      else if (fn === "slot") r = A.examSlot(args[0])
      else if (fn === "html") r = A.htmlToText(args[0])
      else if (fn === "short") r = A.shortCourse(args[0].shortname || args[0].fullname || String(args[0].id))
      else if (fn === "diff") r = A.diffSummary(args[0], args[1])
      else if (fn === "grade") r = A.fmtGrade(args[0])
      else if (fn === "merge") r = A.mergedEvents(args[0], A.supersede(args[1]), new Date(now)).map(e => [e.course, e.type, e.date, e._t || null, e.text_dates || null, e.changed_from || null])
      out.push(JSON.stringify({ ok: r }))
    } catch (e) { out.push(JSON.stringify({ err: String(e) })) }
  }
  fs.writeFileSync(process.argv[2] + ".out", out.join("\n"))
})()
