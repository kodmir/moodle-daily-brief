#!/usr/bin/env python3
"""
Moodle Sabah Brifingi
Bir Moodle sitesini (varsayılan: Boğaziçi) web service API ile tarar (dersler, duyurular, forumlar, dosyalar,
ödevler, quizler, takvim, bildirimler, mesajlar), yeni içerikleri Claude ile okur,
tarihleri çıkarır ve her sabah Telegram'a özet yollar.

Komutlar:
  run             Normal çalıştırma (launchd bunu çağırır). Günde bir kez gönderir.
  run --force     Bugün zaten gönderildiyse bile tekrar gönder.
  test            Brifingi ekrana basar, Telegram'a yollamaz, hiçbir şeyi "görüldü" saymaz.
  init            İlk kurulum: tüm dersleri tarar, belgelerden tarihleri çıkarır, ekrana basar.
  courses         Taranan dersleri listeler (ID'leriyle).
  setup-telegram  Bota mesaj attıktan sonra chat ID'ni bulup .env'e yazar.
"""
import argparse
import hashlib
import html
import io
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATE_FILE = DATA_DIR / "state.json"
LOG_FILE = DATA_DIR / "log.txt"
ENV_FILE = BASE_DIR / ".env"
TZ = ZoneInfo("Europe/Istanbul")

load_dotenv(ENV_FILE)


def _load_secret_blob() -> None:
    """Tüm ayarlar tek bir GitHub secret'ına yazılmışsa (BRIEF_SECRETS) onları ayıklar.
    'moodle_token: xxx', 'MOODLE_TOKEN=xxx', 'telegram bot token - xxx' gibi biçimleri ve etiketsiz değerleri
    kabul eder; etiket tanınmazsa değerin biçimine bakar. Değerler asla log'a yazılmaz."""
    blob = os.getenv("BRIEF_SECRETS", "")
    if not blob.strip():
        return
    found: Dict[str, str] = {}
    for raw in re.split(r"[\r\n;]+", blob):
        line = raw.strip().strip('"').strip("'")
        if not line:
            continue
        m = re.match(r"^\s*([A-Za-z_ \-]+?)\s*[:=\-]\s*(\S+)\s*$", line)
        label, val = (m.group(1).lower().replace(" ", "_").replace("-", "_"), m.group(2)) if m else ("", line)
        val = val.strip().strip('"').strip("'")
        if "moodle" in label or (not label and re.fullmatch(r"[0-9a-f]{32}", val)):
            found.setdefault("MOODLE_TOKEN", val)
        elif "chat" in label:
            found.setdefault("TELEGRAM_CHAT_ID", val)
        elif "bot" in label or "telegram" in label:
            found.setdefault("TELEGRAM_BOT_TOKEN", val)
        # etiketsiz/tanınmayan: biçimden tahmin
        elif re.fullmatch(r"[0-9a-f]{32}", val):
            found.setdefault("MOODLE_TOKEN", val)
        elif re.fullmatch(r"\d{6,12}:[A-Za-z0-9_-]{30,}", val):
            found.setdefault("TELEGRAM_BOT_TOKEN", val)
        elif re.fullmatch(r"-?\d{5,15}", val):
            found.setdefault("TELEGRAM_CHAT_ID", val)
    for k, v in found.items():
        if not os.getenv(k, "").strip():
            os.environ[k] = v


_load_secret_blob()
MOODLE_URL = os.getenv("MOODLE_URL", "https://moodle.bogazici.edu.tr").rstrip("/")
MOODLE_TOKEN = os.getenv("MOODLE_TOKEN", "").strip()
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
TG_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TG_CHAT = os.getenv("TELEGRAM_CHAT_ID", "").strip()
EXTRACT_MODEL = os.getenv("EXTRACT_MODEL", "claude-haiku-5-5")
BRIEF_MODEL = os.getenv("BRIEF_MODEL", "claude-sonnet-5-5")
MAX_FILE_MB = float(os.getenv("MAX_FILE_MB", "25"))
MAX_TEXT_CHARS = int(os.getenv("MAX_TEXT_CHARS", "40000"))
LOOKAHEAD_DAYS = int(os.getenv("LOOKAHEAD_DAYS", "45"))
# API key yoksa ücretsiz mod: Claude kullanılmaz, tarihler metinden kurallarla çıkarılır
FREE_MODE = not ANTHROPIC_API_KEY
MODE = "free5" if FREE_MODE else "claude"


def _id_list(name: str) -> List[int]:
    raw = os.getenv(name, "").strip()
    return [int(x) for x in re.split(r"[,\s]+", raw) if x.strip().isdigit()]


COURSE_IDS = _id_list("COURSE_IDS")
EXCLUDE_COURSE_IDS = _id_list("EXCLUDE_COURSE_IDS")

WARNINGS: List[str] = []
GUN = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]
SUPPORTED_EXT = {".pdf", ".docx", ".pptx", ".txt", ".md", ".csv", ".html", ".htm"}


# ---------------------------------------------------------------- yardımcılar

def log(msg: str) -> None:
    line = f"[{datetime.now(TZ):%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    DATA_DIR.mkdir(exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def h(*parts: Any) -> str:
    return hashlib.sha1("||".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:16]


def html_to_text(s: Optional[str]) -> str:
    if not s:
        return ""
    s = re.sub(r"(?is)<(script|style).*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h\d>|</tr>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v\xa0]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n\n", s)
    return s.strip()


def short_course(c: Dict[str, Any]) -> str:
    """'2026/2027-1 IE  306.01' -> 'IE306'"""
    s = html.unescape(c.get("shortname") or c.get("fullname") or str(c.get("id")))
    s = re.sub(r"^\s*\d{4}/\d{4}-\d\s*", "", s)
    m = re.match(r"([A-Za-zÇĞİÖŞÜçğıöşü]{2,6})\s*(\d{3}[A-Z]?)", s)
    return f"{m.group(1).upper()}{m.group(2)}" if m else s.strip()


def fmt_ts(ts: int) -> str:
    dt = datetime.fromtimestamp(ts, TZ)
    return f"{dt:%Y-%m-%d %H:%M} {GUN[dt.weekday()]}"


def flatten(d: Any, prefix: str = "") -> Dict[str, Any]:
    """Moodle REST'in beklediği a[b][0]=c biçimine çevirir."""
    out: Dict[str, Any] = {}
    if isinstance(d, dict):
        for k, v in d.items():
            out.update(flatten(v, f"{prefix}[{k}]" if prefix else str(k)))
    elif isinstance(d, (list, tuple)):
        for i, v in enumerate(d):
            out.update(flatten(v, f"{prefix}[{i}]"))
    else:
        out[prefix] = int(d) if isinstance(d, bool) else d
    return out


BACKUP_FILE = DATA_DIR / "state.bak.json"


def _empty_state() -> Dict[str, Any]:
    return {"seen": {}, "extracted": {}, "missing": {}, "last_sent_date": None, "last_run_ts": None,
            "last_error": {}}


def load_state() -> Dict[str, Any]:
    for f in (STATE_FILE, BACKUP_FILE):
        if f.exists():
            try:
                st = json.loads(f.read_text(encoding="utf-8"))
                base = _empty_state()
                base.update(st)
                if f is BACKUP_FILE:
                    log("UYARI: state.json bozuktu, yedekten yüklendi")
                return base
            except Exception:
                log(f"UYARI: {f.name} okunamadı")
    return _empty_state()


def save_state(state: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    if STATE_FILE.exists():
        try:
            json.loads(STATE_FILE.read_text(encoding="utf-8"))  # sadece sağlam dosyayı yedekle
            BACKUP_FILE.write_bytes(STATE_FILE.read_bytes())
        except Exception:
            pass
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE_FILE)


def rotate_log() -> None:
    """Log 2 MB'ı geçince tarihli bir dosyaya taşınır. Eski loglar asla silinmez."""
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 2 * 1024 * 1024:
            (DATA_DIR / "logs").mkdir(exist_ok=True)
            LOG_FILE.replace(DATA_DIR / "logs" / f"log-{datetime.now(TZ):%Y%m%d-%H%M%S}.txt")
    except Exception:
        pass


ARCHIVE_FILE = DATA_DIR / "archive.jsonl"


def archive(it: Dict[str, Any], ex: Optional[Dict[str, Any]]) -> None:
    """Moodle'da görülen her öğenin her sürümü buraya EKLENİR (append-only), hiçbir satır silinmez.
    Hoca duyuruyu silse ya da değiştirse bile ilk hali burada kalır."""
    try:
        DATA_DIR.mkdir(exist_ok=True)
        rec = {"archived_at": datetime.now(TZ).isoformat(timespec="seconds"), "key": it["key"],
               "version": it["version"], "course": it["course"], "kind": it["kind"], "title": it["title"],
               "time": it.get("time"), "url": it.get("url"), "text": it.get("text"),
               "file": (it.get("file") or {}).get("name"), "events": (ex or {}).get("events", [])}
        with open(ARCHIVE_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        log(f"Arşive yazılamadı: {e}")


# ---------------------------------------------------------------- Moodle

class MoodleError(Exception):
    """Moodle'ın kendi hatası (izin yok, fonksiyon kapalı vb.). O bölüm atlanır, çalışma sürer."""


class TokenError(Exception):
    """Token geçersiz / süresi dolmuş. Çalışma durur, kullanıcı uyarılır."""


class TransientError(Exception):
    """İnternet yok, Moodle bakımda, zaman aşımı. Çalışma durur, sonra tekrar denenir."""


TOKEN_CODES = {"invalidtoken", "accessexception", "invalidlogin", "usernotfullysetup", "forcepasswordchange"}


class Moodle:
    def __init__(self, url: str, token: str):
        self.url, self.token = url, token
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "moodle-brief/1.0"

    def call(self, fn: str, **params: Any) -> Any:
        data = {"wstoken": self.token, "wsfunction": fn, "moodlewsrestformat": "json"}
        data.update(flatten(params))
        last = None
        for attempt in range(3):
            try:
                r = self.s.post(f"{self.url}/webservice/rest/server.php", data=data, timeout=60)
                if r.status_code >= 500 or r.status_code == 429:
                    raise TransientError(f"Moodle HTTP {r.status_code}")
                r.raise_for_status()
                try:
                    j = r.json()
                except ValueError:
                    # bakım sayfası / giriş sayfası HTML döndü
                    raise TransientError("Moodle JSON yerine HTML döndürdü (bakımda olabilir)")
                break
            except (requests.ConnectionError, requests.Timeout, TransientError) as e:
                last = e
                time.sleep([5, 15, 0][attempt])
        else:
            raise TransientError(f"{fn}: {last}")
        if isinstance(j, dict) and j.get("exception"):
            code = (j.get("errorcode") or "").lower()
            if code in TOKEN_CODES and fn in ("core_webservice_get_site_info", "core_enrol_get_users_courses"):
                raise TokenError(f"{code} — {j.get('message')}")
            raise MoodleError(f"{fn}: {code} — {j.get('message')}")
        return j

    def try_call(self, fn: str, default: Any = None, **params: Any) -> Any:
        """Moodle bir bölüme izin vermezse uyarı verip devam eder. İnternet/bakım hatası ise yukarı fırlatır:
        yarım veriyle 'hiçbir şey yok' diye yanlış brifing göndermektense hiç göndermemek daha iyi."""
        try:
            return self.call(fn, **params)
        except MoodleError as e:
            msg = f"{fn} çalışmadı ({e})"
            log("UYARI " + msg)
            if fn not in " ".join(WARNINGS):
                WARNINGS.append(msg)
            return default

    def download(self, fileurl: str) -> Optional[bytes]:
        url = fileurl
        if "/webservice/pluginfile.php" not in url and "/pluginfile.php" in url:
            url = url.replace("/pluginfile.php", "/webservice/pluginfile.php")
        limit = int(MAX_FILE_MB * 1024 * 1024)
        for method in ("post", "get"):
            try:
                if method == "post":
                    r = self.s.post(url, data={"token": self.token}, timeout=120, stream=True)
                else:
                    r = self.s.get(url, params={"token": self.token}, timeout=120, stream=True)
                if r.status_code != 200:
                    continue
                buf = io.BytesIO()
                for chunk in r.iter_content(65536):
                    buf.write(chunk)
                    if buf.tell() > limit:
                        log(f"Dosya çok büyük, atlandı: {fileurl.split('/')[-1]}")
                        return None
                data = buf.getvalue()
                if data[:200].lstrip().startswith(b"{") and b"exception" in data[:500]:
                    continue
                return data
            except Exception as e:
                log(f"İndirme hatası ({method}): {e}")
        return None


# ---------------------------------------------------------------- dosya metni

def file_text(data: bytes, filename: str) -> str:
    ext = Path(filename).suffix.lower()
    try:
        if ext == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            parts: List[str] = []
            for p in reader.pages:
                parts.append(p.extract_text() or "")
                if sum(map(len, parts)) > MAX_TEXT_CHARS:
                    break
            txt = "\n".join(parts).strip()
            return txt or "[Taranmış/görsel PDF — metin çıkarılamadı]"
        if ext == ".docx":
            import docx
            d = docx.Document(io.BytesIO(data))
            parts = [p.text for p in d.paragraphs]
            for t in d.tables:
                for row in t.rows:
                    parts.append(" | ".join(c.text for c in row.cells))
            return "\n".join(parts)
        if ext == ".pptx":
            from pptx import Presentation
            prs = Presentation(io.BytesIO(data))
            parts = []
            for i, slide in enumerate(prs.slides, 1):
                texts = [sh.text_frame.text for sh in slide.shapes if getattr(sh, "has_text_frame", False)]
                parts.append(f"--- Slayt {i} ---\n" + "\n".join(texts))
            return "\n".join(parts)
        if ext in (".html", ".htm"):
            return html_to_text(data.decode("utf-8", "ignore"))
        if ext in (".txt", ".md", ".csv"):
            return data.decode("utf-8", "ignore")
    except Exception as e:
        return f"[Metin çıkarılamadı: {e}]"
    return ""


# ---------------------------------------------------------------- toplama

def mk(key: str, kind: str, course: str, title: str, text: str = "", t: Optional[int] = None,
       version: Optional[str] = None, url: str = "", file: Optional[Dict[str, Any]] = None,
       extract: bool = True) -> Dict[str, Any]:
    title = html.unescape(title or "")  # Moodle adları "&amp;" gibi kodlu gelebiliyor
    return {"key": key, "kind": kind, "course": course, "title": title, "text": text, "time": t,
            "version": version or h(title, text), "url": url, "file": file, "extract": extract}


def struct_ev(course: str, title: str, typ: str, ts: int, source: str) -> Dict[str, Any]:
    dt = datetime.fromtimestamp(ts, TZ)
    return {"course": course, "title": title, "type": typ, "date": dt.strftime("%Y-%m-%d"),
            "time": dt.strftime("%H:%M"), "certainty": "exact", "source": source}


def _replies(m: "Moodle", d: Dict[str, Any], did: Any, tm: Any, kind: str, cn: str, subj: str,
             reply_cache: Dict[str, Any], new_cache: Dict[str, Any]) -> List[Dict[str, Any]]:
    ck = f"{tm}:{d.get('numreplies')}"
    cached = reply_cache.get(str(did))
    if cached and cached.get("v") == ck:
        new_cache[str(did)] = cached
        return cached["items"]
    pr = m.try_call("mod_forum_get_discussion_posts", default=None, discussionid=did)
    if pr is None:  # bu Moodle'da kapalıysa eski sonucu koru
        if cached:
            new_cache[str(did)] = cached
            return cached["items"]
        return []
    out = []
    for p in pr.get("posts", []):
        if p.get("parentid") in (0, None) or p.get("id") == d.get("id"):
            continue  # ilk mesaj zaten ayrıca alındı
        ptxt = html_to_text(p.get("message"))
        if not ptxt:
            continue
        who = (p.get("author") or {}).get("fullname") or p.get("userfullname") or "?"
        pt = p.get("timecreated") or p.get("created") or tm
        out.append(mk(f"reply:{p.get('id')}", f"{kind} cevabı", cn, f"Re: {subj}",
                      f"Gönderen: {who}\nTarih: {fmt_ts(pt)}\n\n{ptxt}", t=pt,
                      version=h(p.get("timemodified") or pt, ptxt),
                      url=f"{MOODLE_URL}/mod/forum/discuss.php?d={did}#p{p.get('id')}"))
    new_cache[str(did)] = {"v": ck, "items": out}
    return out


def active_courses(m: Moodle, userid: int) -> List[Dict[str, Any]]:
    courses = m.call("core_enrol_get_users_courses", userid=userid)
    now = int(time.time())
    out = []
    for c in courses:
        if c["id"] in EXCLUDE_COURSE_IDS:
            continue
        if COURSE_IDS:
            if c["id"] in COURSE_IDS:
                out.append(c)
            continue
        start, end = c.get("startdate") or 0, c.get("enddate") or 0
        if end:
            ok = end > now - 14 * 86400 and start < now + 30 * 86400
        else:
            ok = start > now - 200 * 86400
        if ok and not c.get("hidden"):
            out.append(c)
    return out


def collect(m: Moodle, reply_cache: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    reply_cache = reply_cache or {}
    new_cache: Dict[str, Any] = {}
    info = m.call("core_webservice_get_site_info")
    userid = info["userid"]
    courses = active_courses(m, userid)
    cname = {c["id"]: short_course(c) for c in courses}
    cids = list(cname)
    now = int(time.time())
    items: List[Dict[str, Any]] = []
    struct: List[Dict[str, Any]] = []
    log(f"{len(courses)} ders taranıyor: {', '.join(cname.values())}")

    # 1) Ders içerikleri: bölümler, etkinlikler, dosyalar, sayfalar
    for c in courses:
        cn = cname[c["id"]]
        for s in m.try_call("core_course_get_contents", default=[], courseid=c["id"]) or []:
            summ = html_to_text(s.get("summary"))
            if summ:
                items.append(mk(f"section:{c['id']}:{s.get('id')}", "bölüm", cn,
                                s.get("name") or "Bölüm açıklaması", summ))
            for mod in s.get("modules", []):
                if mod.get("uservisible") is False:
                    continue
                cmid, modname, name = mod.get("id"), mod.get("modname", ""), mod.get("name", "")
                desc = html_to_text(mod.get("description"))
                dates = [f"{d.get('label')}: {fmt_ts(d['timestamp'])}" for d in mod.get("dates") or []
                         if d.get("timestamp")]
                urls = [x.get("fileurl", "") for x in mod.get("contents") or [] if x.get("type") == "url"]
                text = "\n".join(filter(None, [desc, "\n".join(dates), "\n".join(urls)]))
                items.append(mk(f"mod:{cmid}", f"etkinlik ({modname})", cn, name, text,
                                url=mod.get("url", ""), extract=bool(desc or dates)))
                for d in mod.get("dates") or []:
                    if d.get("timestamp") and d["timestamp"] > now - 86400:
                        lab = (d.get("label") or "").strip(" :").lower()
                        lab = {"due": "teslim", "closes": "kapanış", "opens": "açılış", "closed": "kapanış",
                               "opened": "açılış"}.get(lab, lab)
                        if lab == "açılış" and modname != "quiz":
                            continue  # anket/ödev açılışları gürültü; kapanış ve teslim önemli
                        if lab in ("cut-off date", "remind me to grade by", "kesme tarihi"):
                            continue
                        title = f"{name} ({lab})" if lab and lab != "teslim" else name
                        struct.append(struct_ev(cn, title, modname, d["timestamp"], "moodle"))
                for f in mod.get("contents") or []:
                    if f.get("type") != "file":
                        continue
                    fname = f.get("filename", "")
                    tm = f.get("timemodified") or f.get("timecreated")
                    kind = "sayfa" if modname == "page" else "dosya"
                    items.append(mk(f"file:{cmid}:{f.get('filepath', '/')}{fname}", kind, cn,
                                    name if modname == "page" else f"{name} / {fname}", t=tm,
                                    version=f"{tm}:{f.get('filesize')}", url=mod.get("url", ""),
                                    file={"url": f.get("fileurl"), "name": fname, "size": f.get("filesize") or 0}))

    # 2) Forumlar ve duyurular
    forums = m.try_call("mod_forum_get_forums_by_courses", default=[], courseids=cids) or []
    for fo in forums:
        cn = cname.get(fo.get("course"), "?")
        kind = "duyuru" if fo.get("type") == "news" else "forum"
        res = m.try_call("mod_forum_get_forum_discussions", default=None, forumid=fo["id"], page=0, perpage=40)
        if res is None:
            res = m.try_call("mod_forum_get_forum_discussions_paginated", default={}, forumid=fo["id"],
                             sortby="timemodified", sortdirection="DESC", page=0, perpage=40)
        for d in (res or {}).get("discussions", []):
            did = d.get("discussion") or d.get("id")
            tm = d.get("modified") or d.get("timemodified") or d.get("created")
            subj = (d.get("subject") or d.get("name") or "(konu yok)").strip()
            body = html_to_text(d.get("message"))
            atts = d.get("attachments") if isinstance(d.get("attachments"), list) else []
            att_names = ", ".join(a.get("filename", "") for a in atts)
            text = f"Gönderen: {d.get('userfullname', '?')}\nTarih: {fmt_ts(d.get('created') or tm)}\n\n{body}"
            if att_names:
                text += f"\n\nEkler: {att_names}"
            # sürüm metnin kendisini de içerir: hoca duyuruyu düzenleyip tarihi değiştirirse yakalanır
            ver = h(tm, subj, body)
            items.append(mk(f"disc:{did}", kind, cn, subj, text, t=d.get("created") or tm, version=ver,
                            url=f"{MOODLE_URL}/mod/forum/discuss.php?d={did}"))
            # cevaplar ("düzeltme: sınıf değişti" gibi) ayrı öğe olarak okunur.
            # Tartışma değişmediyse önceki çalıştırmanın sonucu kullanılır (her sabah yüzlerce istek atmamak için)
            if (d.get("numreplies") or 0) > 0:
                items.extend(_replies(m, d, did, tm, kind, cn, subj, reply_cache, new_cache))
            for a in atts:
                fn = a.get("filename", "")
                if a.get("fileurl"):
                    items.append(mk(f"att:{did}:{fn}", f"{kind} eki", cn, f"{subj} / {fn}", t=tm,
                                    version=f"{a.get('timemodified', tm)}:{a.get('filesize')}",
                                    file={"url": a["fileurl"], "name": fn, "size": a.get("filesize") or 0}))

    # 3) Ödevler
    res = m.try_call("mod_assign_get_assignments", default={}, courseids=cids) or {}
    for c in res.get("courses", []):
        cn = cname.get(c.get("id"), c.get("shortname", "?"))
        for a in c.get("assignments", []):
            due = a.get("duedate") or 0
            intro = html_to_text(a.get("intro"))
            text = f"Son teslim: {fmt_ts(due) if due else 'belirtilmemiş'}\n{intro}"
            items.append(mk(f"assign:{a['id']}", "ödev", cn, a.get("name", ""), text, t=a.get("timemodified"),
                            version=h(a.get("name"), due, intro)))
            if due and due > now - 86400:
                struct.append(struct_ev(cn, a.get("name", ""), "ödev teslimi", due, "moodle ödev"))
            for f in a.get("introattachments") or []:
                fn = f.get("filename", "")
                items.append(mk(f"assignatt:{a['id']}:{fn}", "ödev eki", cn, f"{a.get('name')} / {fn}",
                                t=f.get("timemodified"), version=f"{f.get('timemodified')}:{f.get('filesize')}",
                                file={"url": f.get("fileurl"), "name": fn, "size": f.get("filesize") or 0}))

    # 4) Quizler
    res = m.try_call("mod_quiz_get_quizzes_by_courses", default={}, courseids=cids) or {}
    for q in res.get("quizzes", []):
        cn = cname.get(q.get("course"), "?")
        o, cl = q.get("timeopen") or 0, q.get("timeclose") or 0
        intro = html_to_text(q.get("intro"))
        text = f"Açılış: {fmt_ts(o) if o else '-'}\nKapanış: {fmt_ts(cl) if cl else '-'}\n{intro}"
        items.append(mk(f"quiz:{q['id']}", "quiz", cn, q.get("name", ""), text, version=h(q.get("name"), o, cl, intro)))
        if o and o > now - 86400:
            struct.append(struct_ev(cn, q.get("name", ""), "quiz açılış", o, "moodle quiz"))
        if cl and cl > now - 86400:
            struct.append(struct_ev(cn, q.get("name", ""), "quiz kapanış", cl, "moodle quiz"))

    # 5) Takvim
    t0, t1 = now - 86400, now + LOOKAHEAD_DAYS * 86400
    res = m.try_call("core_calendar_get_calendar_events", default={},
                     events={"courseids": cids},
                     options={"userevents": 1, "siteevents": 1, "timestart": t0, "timeend": t1}) or {}
    cal = list(res.get("events", []))
    res2 = m.try_call("core_calendar_get_action_events_by_timesort", default={},
                      timesortfrom=t0, timesortto=t1, limitnum=50) or {}
    seen_ids = {e.get("id") for e in cal}
    for e in res2.get("events", []):
        if e.get("id") not in seen_ids:
            e.setdefault("timestart", e.get("timesort"))
            e.setdefault("courseid", (e.get("course") or {}).get("id"))
            cal.append(e)
    for e in cal:
        ts = e.get("timestart") or e.get("timesort")
        if not ts:
            continue
        cn = cname.get(e.get("courseid"), "Genel")
        desc = html_to_text(e.get("description"))
        typ = e.get("modulename") or e.get("eventtype") or "etkinlik"
        struct.append(struct_ev(cn, e.get("name", ""), typ, ts, "moodle takvim"))
        items.append(mk(f"cal:{e.get('id')}", "takvim", cn, e.get("name", ""),
                        f"{fmt_ts(ts)}\n{desc}", t=e.get("timemodified"), version=h(e.get("name"), ts, desc),
                        extract=bool(desc)))

    # 6) Bildirimler (not girildi, yeni gönderi vb.)
    res = m.try_call("message_popup_get_popup_notifications", default={}, useridto=userid, limit=50, offset=0) or {}
    for n in res.get("notifications", []):
        body = n.get("smallmessage") or html_to_text(n.get("fullmessagehtml")) or n.get("fullmessage") or ""
        items.append(mk(f"notif:{n.get('id')}", "bildirim", "Bildirim", n.get("subject", ""), body,
                        t=n.get("timecreated"), version="1", url=n.get("contexturl") or ""))

    # 7) Mesajlar (hocalardan / asistanlardan)
    res = m.try_call("core_message_get_conversations", default={}, userid=userid, limitfrom=0, limitnum=20) or {}
    for conv in res.get("conversations", []):
        who = ", ".join(mb.get("fullname", "") for mb in conv.get("members", []) if mb.get("id") != userid)
        for msg in conv.get("messages", []):
            if msg.get("useridfrom") == userid:
                continue
            items.append(mk(f"msg:{msg.get('id')}", "mesaj", "Mesaj", f"{who or conv.get('name', '')}",
                            html_to_text(msg.get("text")), t=msg.get("timecreated"), version="1"))

    # tekilleştir
    uniq: Dict[str, Dict[str, Any]] = {}
    for it in items:
        uniq[it["key"]] = it
    sd: Dict[str, Dict[str, Any]] = {}
    for e in struct:
        sd[h(e["course"], e["title"], e["date"], e["time"])] = e
    log(f"{len(uniq)} öğe, {len(sd)} tarihli etkinlik toplandı")
    return {"userid": userid, "courses": courses, "cname": cname, "items": list(uniq.values()),
            "struct": list(sd.values()), "reply_cache": new_cache}


# ---------------------------------------------------------------- Claude

EXTRACT_SYSTEM = """Moodle'dan gelen bir içeriği (duyuru, belge, syllabus, ödev, bildirim) okuyup
akademik açıdan önemli bilgileri çıkaran bir asistansın. SADECE geçerli JSON döndür, başka hiçbir şey yazma.

Şema:
{"summary": "Türkçe 1-2 cümle: ne olduğu + öğrencinin yapması gereken bir şey varsa o",
 "importance": "high | medium | low",
 "events": [{"title": "kısa ad", "type": "midterm|final|quiz|exam|assignment|project|presentation|lab|class_change|registration|other",
             "date": "YYYY-MM-DD", "time": "HH:MM veya null", "certainty": "exact|approximate", "detail": "yer, kapsam vb. kısa"}]}

Kurallar:
- Tarihte yıl yazmıyorsa dersin dönemine ve bugünün tarihine göre yılı belirle.
- Syllabus'ta "Week 7: Midterm" gibi göreli ifade varsa ve dersin başlangıç tarihi biliniyorsa tarihi hesapla, certainty="approximate" yaz.
- Ders iptali, sınıf/saat değişikliği, sınav yeri, kapsamı gibi şeyler önemlidir (importance=high).
- Ders slaytı / okuma materyali gibi tarih içermeyen içerikler için events boş, importance=low.
- Tarih uydurma. Emin olamadığın tarihi koyma."""

BRIEF_SYSTEM = """Sen bir üniversite öğrencisinin akademik asistanısın. Her sabah ona Telegram'dan
brifing yazıyorsun. Sana JSON olarak Moodle'dan toplanmış veri veriliyor.

Kurallar:
- Sadece verilen veriye dayan, tarih uydurma. certainty="approximate" olan tarihleri "(belgeden, teyit et)" diye işaretle.
- Aynı sınav/teslim için kaynaklar farklı tarih veriyorsa ⚠️ ile belirt.
- Düz metin yaz. Markdown kullanma (**, #, _ yok). Emoji başlıklar serbest.
- Her maddede ders kodu olsun. Kısa, doğrudan, dolgu cümlesi yok.
- Toplam 3000 karakteri geçme.

Format:
☀️ <tarih, gün>
📌 BUGÜN — bugünkü teslim/sınav/yapılacaklar (yoksa "Bugün kayıtlı bir şey yok")
📅 BU HAFTA — önümüzdeki 7 gündeki önemli şeyler: tarih, gün, kaç gün kaldı
🎯 EN YAKIN SINAV — tür, ders, tarih, kaç gün kaldı; ardından sonraki 1-2 sınav
🆕 YENİ — son brifingden beri gelen duyuru/belge/bildirim/mesajlar, önemli olan önce, her biri tek satır, gereken aksiyonla
⚠️ DİKKAT — sadece varsa: tarih değişikliği, çelişki, kaçırılmaması gereken şey"""


def parse_json(txt: str) -> Optional[Dict[str, Any]]:
    a, b = txt.find("{"), txt.rfind("}")
    if a == -1 or b == -1:
        return None
    try:
        return json.loads(txt[a:b + 1])
    except Exception:
        return None


class Claude:
    def __init__(self, key: str):
        import anthropic
        self.client = anthropic.Anthropic(api_key=key)

    def ask(self, model: str, system: str, user: str, max_tokens: int) -> str:
        for attempt in range(3):
            try:
                r = self.client.messages.create(model=model, max_tokens=max_tokens, system=system,
                                                messages=[{"role": "user", "content": user}])
                return "".join(getattr(b, "text", "") for b in r.content)
            except Exception as e:
                log(f"Claude hatası ({attempt + 1}/3): {e}")
                time.sleep(5 * (attempt + 1))
        raise RuntimeError("Claude API'ye ulaşılamadı")


def course_start(courses: List[Dict[str, Any]], cn: str) -> str:
    for c in courses:
        if short_course(c) == cn and c.get("startdate"):
            return datetime.fromtimestamp(c["startdate"], TZ).strftime("%Y-%m-%d")
    return "bilinmiyor"


def extract_item(m: Moodle, cl: Claude, it: Dict[str, Any], courses: List[Dict[str, Any]]) -> Dict[str, Any]:
    text = it["text"] or ""
    if it.get("file"):
        f = it["file"]
        ext = Path(f["name"]).suffix.lower()
        if ext not in SUPPORTED_EXT:
            return {"summary": f"Yeni dosya: {f['name']}", "importance": "low", "events": []}
        if f["size"] and f["size"] > MAX_FILE_MB * 1024 * 1024:
            return {"summary": f"Büyük dosya (okunmadı): {f['name']}", "importance": "low", "events": []}
        data = m.download(f["url"]) if f.get("url") else None
        if data is None:
            return {"summary": f"Dosya indirilemedi: {f['name']}", "importance": "low", "events": []}
        text = file_text(data, f["name"])
    if not text.strip():
        return {"summary": it["title"], "importance": "low", "events": []}
    if not it.get("extract", True):
        return {"summary": it["title"], "importance": "low", "events": []}
    today = datetime.now(TZ)
    user = (f"Bugün: {today:%Y-%m-%d} {GUN[today.weekday()]}\nDers: {it['course']} "
            f"(dönem başlangıcı: {course_start(courses, it['course'])})\nTür: {it['kind']}\n"
            f"Başlık: {it['title']}\n\nİçerik:\n{text[:MAX_TEXT_CHARS]}")
    out = parse_json(cl.ask(EXTRACT_MODEL, EXTRACT_SYSTEM, user, 1500))
    if not out:
        return {"summary": it["title"], "importance": "medium", "events": []}
    out.setdefault("events", [])
    return out


# ---------------------------------------------------------------- brifing

def days_left(date_str: str) -> Optional[int]:
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
        return (d - datetime.now(TZ).date()).days
    except Exception:
        return None


def _key_num(key: str) -> int:
    m = re.search(r":(\d+)", key)
    return int(m.group(1)) if m else 0


ROMAN = {"i": "1", "ii": "2", "iii": "3"}


def exam_slot(e: Dict[str, Any]) -> Optional[str]:
    """Aynı sınavı tanımlayan anahtar: 'midterm', 'midterm2', 'final', 'quiz3'... Sınav değilse None."""
    typ = e.get("type") or ""
    title = (e.get("title") or "").replace("İ", "i").lower()
    num = None
    m = re.search(r"(?:midterm|mid-term|ara s[ıi]nav|vize|quiz|exam|s[ıi]nav)\s*#?\s*(\d|iii|ii|i)\b", title) \
        or re.search(r"\b(\d)(?:st|nd|rd|th)\s+(?:midterm|exam|quiz)", title) \
        or re.search(r"\b(\d)\.\s*(?:ara s[ıi]nav|vize|quiz|s[ıi]nav)", title)
    if m:
        num = ROMAN.get(m.group(1), m.group(1))
    if typ in ("midterm", "final", "quiz", "exam"):
        base = "midterm" if typ == "exam" and re.search(r"midterm|ara s[ıi]nav|vize", title) else typ
        return base + (num or "")
    return None


def supersede(evs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Aynı ders + aynı sınav için farklı duyurular farklı tarih veriyorsa, en son yayınlanan duyurunun
    tarihini tut; değişikliği 'changed_from' alanında işaretle."""
    groups: Dict[Any, List[Dict[str, Any]]] = {}
    out = []
    for e in evs:
        slot = exam_slot(e)
        if slot is None:
            out.append(e)
        else:
            groups.setdefault((e.get("course"), slot), []).append(e)
    for _, g in groups.items():
        dates = {x["date"] for x in g}
        if len(dates) == 1:
            out.extend(g)
            continue
        newest = max(x["posted"] for x in g)
        keep = [x for x in g if x["posted"] == newest]
        old = sorted({x["date"] for x in g if x["posted"] != newest} - {x["date"] for x in keep})
        for x in keep:
            if old:
                x["changed_from"] = old[-1]
        out.extend(keep)
    return out


def build_context(data: Dict[str, Any], state: Dict[str, Any], new_items: List[Dict[str, Any]]) -> Dict[str, Any]:
    today = datetime.now(TZ)
    upcoming = []
    for e in data["struct"]:
        dl = days_left(e["date"])
        if dl is not None and 0 <= dl <= LOOKAHEAD_DAYS:
            upcoming.append({**e, "days_left": dl})
    all_docs = []
    for key, ex in state["extracted"].items():
        if ex.get("hidden"):
            continue  # Moodle'dan kaldırılmış öğe: kayıtta duruyor ama gösterilmez
        posted = ex.get("posted") or _key_num(key)
        for e in ex.get("events", []):
            if days_left(e.get("date") or "") is not None:
                all_docs.append({**e, "course": ex.get("course"), "source": ex.get("title"),
                                 "posted": posted, "item": key})
    from_docs = []
    for e in supersede(all_docs):  # eski duyurudaki tarih, yeni duyuruyla değiştiyse eskisini at
        dl = days_left(e["date"])
        if dl >= 0:
            from_docs.append({**e, "days_left": dl})
    upcoming.sort(key=lambda e: (e["date"], e.get("time") or ""))
    from_docs.sort(key=lambda e: (e["date"], e.get("time") or ""))
    news = []
    rank = {"high": 0, "medium": 1, "low": 2}
    for it in new_items:
        ex = state["extracted"].get(it["key"], {})
        news.append({"course": it["course"], "kind": it["kind"], "title": it["title"],
                     "summary": ex.get("summary", ""), "importance": ex.get("importance", "medium"),
                     "updated": it.get("updated", False)})
    news.sort(key=lambda x: rank.get(x["importance"], 1))
    return {"today": f"{today:%Y-%m-%d} {GUN[today.weekday()]}",
            "courses": {c.get("shortname"): c.get("fullname") for c in data["courses"]},
            "moodle_calendar_and_deadlines": upcoming[:120],
            "dates_found_in_documents": from_docs[:150],
            "new_since_last_brief": news[:60],
            "last_sent": state.get("last_sent_date"),
            "api_warnings": WARNINGS}


def fallback_brief(ctx: Dict[str, Any]) -> str:
    lines = [f"☀️ {ctx['today']} (Claude'a ulaşılamadı, ham liste)"]
    evs = ctx["moodle_calendar_and_deadlines"] + ctx["dates_found_in_documents"]
    evs.sort(key=lambda e: (e["date"], e.get("time") or ""))
    lines.append("\n📌 BUGÜN")
    lines += [f"• {e['course']}: {e['title']} {e.get('time') or ''}" for e in evs if e["days_left"] == 0] or ["• Kayıt yok"]
    lines.append("\n📅 7 GÜN")
    lines += [f"• {e['date']} ({e['days_left']}g) {e['course']}: {e['title']}" for e in evs if 1 <= e["days_left"] <= 7]
    exams = [e for e in evs if any(k in (e.get("type") or "").lower() for k in ("exam", "midterm", "final", "quiz"))]
    if exams:
        e = exams[0]
        lines.append(f"\n🎯 EN YAKIN SINAV: {e['course']} {e['title']} — {e['date']} ({e['days_left']} gün)")
    return "\n".join(lines)


def footer(new_items: List[Dict[str, Any]]) -> str:
    if not new_items:
        return ""
    lines = [f"\n— Tüm yeni öğeler ({len(new_items)}) —"]
    for it in new_items[:40]:
        tag = " (güncellendi)" if it.get("updated") else ""
        lines.append(f"• [{it['course']}] {it['kind']}: {it['title'][:90]}{tag}")
    if len(new_items) > 40:
        lines.append(f"… ve {len(new_items) - 40} öğe daha (data/log.txt)")
    return "\n".join(lines)


# ---------------------------------------------------------------- ücretsiz mod

TR_AY = {"ocak": 1, "şubat": 2, "subat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "mayis": 5,
         "haziran": 6, "temmuz": 7, "ağustos": 8, "agustos": 8, "eylül": 9, "eylul": 9,
         "ekim": 10, "kasım": 11, "kasim": 11, "aralık": 12, "aralik": 12}
EN_AY = {"january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7,
         "august": 8, "september": 9, "sept": 9, "october": 10, "november": 11, "december": 12}
EN_KISA = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8, "sep": 9,
           "oct": 10, "nov": 11, "dec": 12}
AY_KISA = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]
GUN_KISA = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"]

KEYWORDS = [
    ("midterm", r"midterm|mid-term|ara ?s[ıi]nav|vize"),
    ("final", r"\bfinal"),
    ("quiz", r"quiz"),
    ("exam", r"exam|s[ıi]nav"),
    ("assignment", r"[öo]dev|homework|\bhw ?\d|assignment|\bdue\b|teslim|deadline|submission"),
    ("project", r"proje|project"),
    ("presentation", r"sunum|presentation"),
    ("lab", r"\blab"),
    ("class_change", r"iptal|cancel|telafi|make-?up|ertelen|postpone|resched"),
]
TYPE_TR = {"midterm": "ara sınav", "final": "final", "quiz": "quiz", "exam": "sınav", "assignment": "ödev",
           "project": "proje", "presentation": "sunum", "lab": "lab", "class_change": "ders değişikliği",
           "other": "tarih", "assign": "ödev", "due": "teslim", "course": "ders etkinliği",
           "user": "kişisel", "site": "genel", "open": "açılış", "close": "kapanış"}
EXAM_RE = re.compile(r"midterm|mid-term|vize|s[ıiIİ]nav|\bfinal|quiz|exam", re.I)

RE_DAY_MON = re.compile(r"(?<![\d])(\d{1,2})(?:st|nd|rd|th)?\.?\s*(?:of\s+)?([A-Za-zÇĞİÖŞÜçğıöşü]{3,9})(?:[\s,]+(20\d\d))?")
RE_MON_DAY = re.compile(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(20\d\d))?")
RE_NUM = re.compile(r"(?<![\d.,/:])(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?!\d|[./:]\d)")
RE_TIME = re.compile(r"(?:saat\s*|at\s*|@\s*)?\b([01]?\d|2[0-3])[:.]([0-5]\d)\b")


def _lower_tr(s: str) -> str:
    return s.replace("İ", "i").replace("I", "ı").lower()


def month_of(word: str) -> Optional[int]:
    w = _lower_tr(word)
    for name, m in TR_AY.items():
        if w.startswith(name):
            return m
    w2 = word.lower()
    if w2 in EN_AY:
        return EN_AY[w2]
    if w2 in EN_KISA:
        return EN_KISA[w2]
    return None


def _make_date(day: int, mon: int, year: Optional[int]) -> Optional[datetime]:
    today = datetime.now(TZ).date()
    try:
        if year:
            y = year + 2000 if year < 100 else year
            return datetime(y, mon, day)
        d = datetime(today.year, mon, day)
        if d.date() < today - timedelta(days=60):
            d = datetime(today.year + 1, mon, day)
        return d
    except ValueError:
        return None


def _span(text: str, s: int, e: int):
    """Tarihin geçtiği cümlenin sınırları."""
    a = max(text.rfind("\n", 0, s), text.rfind(". ", 0, s), text.rfind("! ", 0, s), text.rfind("? ", 0, s)) + 1
    ends = [x for x in (text.find("\n", e), text.find(". ", e), text.find("! ", e), text.find("? ", e)) if x != -1]
    return a, (min(ends) if ends else len(text))


def _sentence(text: str, s: int, e: int) -> str:
    a, b = _span(text, s, e)
    sent = re.sub(r"\s+", " ", text[a:b]).strip(" .-:")
    return sent if len(sent) <= 80 else sent[:77] + "…"


WEEKDAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
            "pazartesi": 0, "salı": 1, "sali": 1, "çarşamba": 2, "carsamba": 2, "perşembe": 3, "persembe": 3,
            "cuma": 4, "cumartesi": 5, "pazar": 6}
RE_WD = re.compile(r"\b(" + "|".join(sorted(WEEKDAYS, key=len, reverse=True)) + r")\b")
# "midterm topics", "quiz 1 grades", "sınav sonuçları" → sınavın kendisi değil
RE_NOT_EVENT_AFTER = re.compile(
    r"^\s*(?:#?\s*\d+\s*)?(?:topics?|review|grades?|results?|papers?|objections?|solutions?|coverage|scope|"
    r"preparation|prep|classroom assignments?|seating|notları|notlar|konuları|kapsamı|sonuçları|kağıtları|"
    r"itiraz|çözümleri|hazırlık|grading)"
    # "The assignment will be announced tomorrow", "Quiz 2 date will be announced", "ödev duyurulacak":
    # bir şeyin AÇIKLANACAĞI tarih, o şeyin kendi tarihi değil
    r"|^s?\s*(?:#?\s*\d+\s+)?(?:date\s+|dates\s+|details\s+|tarihi\s+)?(?:will be|is to be|are to be|to be|is going to be)\s+"
    r"(?:announced|posted|shared|published|released|made)"
    r"|^s?\S*\s*(?:\S+\s+){0,3}(?:duyurulacak|açıklanacak|ilan edilecek|paylaşılacak)")
RE_NOT_EVENT_BEFORE = re.compile(r"(?:before|after|for|until|prior to|öncesi|sonrası|için)\s+(?:the\s+)?$")
# "from Nov 11 to Nov 17", "11 Kasım yerine 17 Kasım" → eski tarih
RE_OLD_BEFORE = re.compile(r"(?:\bfrom|instead of|rather than|previously|originally|was scheduled (?:for|on)|"
                           r"was planned (?:for|on)|moved from|eski tarih|önceki tarih)\s*(?:the\s+|on\s+)?$")
RE_OLD_AFTER = re.compile(r"^\s*(?:'?(?:dan|den|tan|ten)\b)?\s*(?:tarihinden|tarihindeki|yerine)")
RE_AMPM = re.compile(r"\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])")
RE_REL_DAY = re.compile(r"\b(yarın(?:ki|da)?|yarin(?:ki|da)?|tomorrow|bugün(?:kü|ki)?|bugun(?:ku|ki)?|today|tonight|bu akşam(?:ki)?)\b")
RE_REL_WD = re.compile(r"\b(this|next|coming|on|bu|önümüzdeki|gelecek|haftaya)\s+(?:week\s+|hafta(?:ki)?\s+)?(" +
                       "|".join(sorted(WEEKDAYS, key=len, reverse=True)) + r")\b")


def _find_time(text: str, s: int, e: int) -> Optional[str]:
    """Tarihten sonraki (yoksa önceki) yakın saati bulur: 17:00, 17.30, 5 pm."""
    for seg in (text[e:e + 35], text[max(0, s - 25):s]):
        tm = RE_TIME.search(seg)
        ap = RE_AMPM.search(seg.lower())
        if ap and (not tm or ap.start() <= tm.start()):
            hh = int(ap.group(1)) % 12 + (12 if ap.group(3).startswith("p") else 0)
            return f"{hh:02d}:{ap.group(2) or '00'}"
        if tm:
            return f"{int(tm.group(1)):02d}:{tm.group(2)}"
    return None


def _classify(low: str, s: int, e: int, a: int, b: int):
    """Tarihin geçtiği cümledeki en yakın anahtar kelimeyle türü belirler. Sınav notu/konusu gibi
    ifadelerde sınav türü verilmez."""
    best, best_dist = None, 10 ** 9
    for typ, pat in KEYWORDS:
        for km in re.finditer(pat, low[a:b]):
            ks, ke = a + km.start(), a + km.end()
            if RE_NOT_EVENT_AFTER.search(low[ke:ke + 50]) or RE_NOT_EVENT_BEFORE.search(low[max(0, ks - 15):ks]):
                continue
            dist = abs(ks - s) + (40 if typ == "exam" else 0)  # özel tür genelden önce
            if dist < best_dist:
                best, best_dist = typ, dist
    return best


SPECIFIC_EXAMS = ("midterm", "final", "quiz")


def _refine(best: Optional[str], low: str, s: int, title_low: str) -> Optional[str]:
    """Cümlede sadece genel 'exam/sınav' geçiyorsa ('The exam will be held on Nov 17'), önceki cümleye ve
    duyuru başlığına bakıp hangi sınav olduğunu bul (Midterm Date Updated → midterm)."""
    if best != "exam":
        return best
    ctx_a = max(0, s - 220)
    for src in (low[ctx_a:s], title_low):
        found = None
        for typ, pat in KEYWORDS:
            if typ not in SPECIFIC_EXAMS:
                continue
            for km in re.finditer(pat, src):
                if RE_NOT_EVENT_AFTER.search(src[km.end():km.end() + 30]):
                    continue
                found = typ  # en sondaki (tarihe en yakın) eşleşme kazanır
        if found:
            return found
    return best


def regex_dates(text: str, posted: Optional[int] = None, title: str = "") -> List[Dict[str, Any]]:
    """Metindeki tarihleri bulur, aynı cümledeki anahtar kelimeye göre türünü belirler.
    posted: duyurunun yayın zamanı ('yarın', 'next Monday' gibi göreli ifadeler için)."""
    if not text:
        return []
    # "Gönderen:" / "Tarih:" başlık satırları tarih değil
    text = "\n".join(l for l in text.split("\n") if not re.match(r"^(Gönderen|Tarih|Son teslim|Açılış|Kapanış):", l))
    low = text.replace("İ", "i").lower()  # İngilizce büyük harf I -> i (MIDTERM -> midterm)
    title_low = (title or "").replace("İ", "i").lower()
    found: Dict[str, Dict[str, Any]] = {}
    cands = []
    for mt in RE_DAY_MON.finditer(text):
        mon = month_of(mt.group(2))
        if mon:
            cands.append((mt.start(), mt.end(), int(mt.group(1)), mon, mt.group(3), True, False))
    for mt in RE_MON_DAY.finditer(text):
        mon = month_of(mt.group(1))
        if mon and mt.group(1).lower() in list(EN_AY) + list(EN_KISA):
            cands.append((mt.start(), mt.end(), int(mt.group(2)), mon, mt.group(3), True, False))
    for mt in RE_NUM.finditer(text):
        # yılsız sayısal tarih ancak ay iki haneyse kabul ("12/11", "06.11"); "2.1", "3.3" gibi bölüm numaraları değil
        if not mt.group(3) and len(mt.group(2)) != 2:
            continue
        before = text[max(0, mt.start() - 12):mt.start()].lower()
        if re.search(r"(section|chapter|sec\.|bölüm|ch\.|•|-|v|version|sürüm)\s*$", before):
            continue
        cands.append((mt.start(), mt.end(), int(mt.group(1)), int(mt.group(2)), mt.group(3), bool(mt.group(3)), True))
    today = datetime.now(TZ).date()
    taken_spans = []
    for s, e, day, mon, year, strong, numeric in cands:
        if any(s < te and e > ts for ts, te in taken_spans):
            continue  # aynı yeri iki desen yakaladıysa bir kez say
        if RE_OLD_BEFORE.search(low[max(0, s - 30):s]) or RE_OLD_AFTER.search(low[e:e + 20]):
            taken_spans.append((s, e))
            continue  # eski (değiştirilmiş) tarih
        y = int(year) if year else None
        d = _make_date(day, mon, y)
        a, b = _span(text, s, e)
        wd_m = RE_WD.search(low[a:b])
        wd_flag = False
        if wd_m:
            wd = WEEKDAYS[wd_m.group(1)]
            if numeric and (not d or d.weekday() != wd):
                alt = _make_date(mon, day, y)  # ay/gün yazılmış olabilir (Amerikan biçimi)
                if alt and alt.weekday() == wd:
                    d = alt
                elif d:
                    wd_flag = True
            elif d and d.weekday() != wd and not numeric:
                wd_flag = True
        if not d:
            continue
        # makul aralık dışı tarihleri at (dönem içi)
        if not (today - timedelta(days=60) <= d.date() <= today + timedelta(days=200 if not year else 365)):
            continue
        best = _refine(_classify(low, s, e, a, b), low, s, title_low)
        if best is None and not strong:
            continue  # "3.5" gibi anlamsız sayıları ele
        taken_spans.append((s, e))
        key = f"{d:%Y-%m-%d}:{best}"
        if key not in found:
            found[key] = {"title": _sentence(text, s, e), "type": best or "other", "date": f"{d:%Y-%m-%d}",
                          "time": _find_time(text, s, e), "certainty": "approximate", "detail": "metinden"}
            if wd_flag:
                found[key]["weekday_mismatch"] = True
    # göreli ifadeler: sadece yayın tarihi biliniyorsa ve cümlede açık bir tarih yoksa
    if posted:
        pd = datetime.fromtimestamp(posted, TZ).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
        rels = []
        for mt in RE_REL_DAY.finditer(low):
            w = mt.group(1)
            rels.append((mt.start(), mt.end(), pd + timedelta(days=1 if w.startswith(("yar", "tom")) else 0)))
        for mt in RE_REL_WD.finditer(low):
            wd = WEEKDAYS[mt.group(2)]
            delta = (wd - pd.weekday()) % 7 or 7
            if mt.group(1) in ("gelecek", "haftaya") and (pd + timedelta(days=delta)).isocalendar()[1] == pd.isocalendar()[1]:
                delta += 7  # "gelecek hafta cuma" bu haftanınki değil ("next Friday" belirsiz, en yakını alınır)
            rels.append((mt.start(), mt.end(), pd + timedelta(days=delta)))
        for s, e, d in rels:
            a, b = _span(text, s, e)
            if any(a <= ts < b for ts, te in taken_spans):
                continue  # cümlede zaten açık tarih var
            best = _refine(_classify(low, s, e, a, b), low, s, title_low)
            if best is None:
                continue
            if not (today - timedelta(days=7) <= d.date() <= today + timedelta(days=60)):
                continue
            key = f"{d:%Y-%m-%d}:{best}"
            if key not in found:
                found[key] = {"title": _sentence(text, s, e), "type": best, "date": f"{d:%Y-%m-%d}",
                              "time": _find_time(text, s, e), "certainty": "approximate", "detail": "göreli"}
    return list(found.values())


def free_extract(it: Dict[str, Any]) -> Dict[str, Any]:
    text = it.get("text") or ""
    if it.get("file"):
        return {"summary": f"Dosya: {it['file']['name']}", "importance": "low", "events": []}
    one = re.sub(r"\s+", " ", text).strip()
    rel_ok = it["kind"] in ("duyuru", "forum", "duyuru cevabı", "forum cevabı", "mesaj", "bildirim")
    events = regex_dates(text, it.get("time") if rel_ok else None, it.get("title") or "") \
        if it["kind"] not in ("takvim",) else []
    imp = "high" if it["kind"] in ("duyuru", "mesaj") or any(e["type"] in ("class_change", "midterm", "final", "exam") for e in events) else "medium"
    return {"summary": one[:160], "importance": imp, "events": events}


def tr_date(ds: str) -> str:
    d = datetime.strptime(ds, "%Y-%m-%d")
    return f"{d.day} {AY_KISA[d.month - 1]} {GUN_KISA[d.weekday()]}"


def is_exam(e: Dict[str, Any]) -> bool:
    t = (e.get("type") or "").lower()
    return t in ("midterm", "final", "quiz", "exam") or "quiz" in t or bool(EXAM_RE.search(e.get("title") or ""))


E = html.escape
STOPWORDS = {"due", "is", "closes", "close", "opens", "open", "kapanış", "açılış", "son", "teslim", "tarihi",
             "the", "submission", "deadline", "assignment", "ödev", "quiz"}
TYPE_LABEL = {"midterm": "Ara sınav", "final": "Final", "quiz": "Quiz", "exam": "Sınav", "assignment": "Ödev",
              "project": "Proje", "presentation": "Sunum", "lab": "Lab", "class_change": "Ders değişikliği"}


def _norm_title(t: str) -> str:
    t = re.sub(r"[^\wçğıöşü ]+", " ", (t or "").replace("İ", "i").lower())
    return " ".join(w for w in t.split() if w not in STOPWORDS)


def _same_thing(a: str, b: str) -> bool:
    na, nb = _norm_title(a), _norm_title(b)
    return bool(na and nb) and (na in nb or nb in na)


def _display_dt(e: Dict[str, Any]):
    """Moodle'da 00:00 teslim = önceki gecenin sonu. Bunu 'önceki gün 23:59' olarak göster."""
    d = datetime.strptime(e["date"], "%Y-%m-%d")
    t = e.get("time")
    if t == "00:00":
        return d - timedelta(days=1), "23:59"
    return d, t


def _days(d: datetime) -> int:
    return (d.date() - datetime.now(TZ).date()).days


def _left(n: int) -> str:
    return "bugün" if n == 0 else ("yarın" if n == 1 else f"{n} gün")


def _exact_slot(e: Dict[str, Any]) -> Optional[str]:
    """Moodle'dan gelen kesin kaydın hangi sınav olduğu ('quiz2', 'midterm'...)."""
    t = (e.get("type") or "").lower()
    title = (e.get("title") or "").replace("İ", "i").lower()
    if "quiz" in t or "quiz" in title:
        typ = "quiz"
    elif re.search(r"midterm|mid-term|ara s[ıi]nav|vize", title):
        typ = "midterm"
    elif re.search(r"\bfinal", title):
        typ = "final"
    else:
        return None
    if re.search(r"\((?:açılış|kapanış)\)", title):
        return None  # açılış/kapanış penceresi, sınav günü olmayabilir
    return exam_slot({"type": typ, "title": title})


def merged_events(ctx: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Aynı teslimin takvim/ödev/etkinlik kopyalarını tek kayda indirir; 'tarih' türündeki belirsiz
    metin eşleşmelerini (ofis saati vb.) listeden çıkarır."""
    out: List[Dict[str, Any]] = []
    prio = {"moodle ödev": 0, "moodle quiz": 1, "moodle": 2, "moodle takvim": 3}
    exact = sorted(ctx["moodle_calendar_and_deadlines"], key=lambda e: prio.get(e.get("source"), 9))
    for e in exact:
        if any(o["course"] == e["course"] and o["date"] == e["date"] and o.get("time") == e.get("time")
               and _same_thing(o["title"], e["title"]) for o in out):
            continue
        out.append(dict(e))
    exact_slots = {(o["course"], s) for o in out for s in [_exact_slot(o)] if s}
    for e in ctx["dates_found_in_documents"]:
        if (e.get("type") or "other") == "other":
            continue  # yakında sınav/ödev kelimesi olmayan tarih — duyuru metninde zaten görünüyor
        sl = exam_slot(e)
        if sl and (e.get("course"), sl) in exact_slots:
            continue  # Moodle'ın kendi kaydı (quiz modülü/takvim) metinden çıkan tarihten daha güvenilir
        dup = False
        for o in out:
            if o["course"] == e.get("course") and o["date"] == e["date"] and (
                    is_exam(o) == is_exam(e) or _same_thing(o["title"], e["title"])):
                dup = True
                break
        if not dup:
            out.append(dict(e))
    for e in out:
        d, t = _display_dt(e)
        e["_d"], e["_t"], e["_n"] = d, t, _days(d)
    out = [e for e in out if e["_n"] >= 0]
    out.sort(key=lambda e: (e["_d"], e["_t"] or "99"))
    return out


def _label(e: Dict[str, Any]) -> str:
    title = (e.get("title") or "").strip()
    typ = e.get("type") or ""
    if e.get("certainty") == "approximate" and typ in TYPE_LABEL:
        # metinden gelen uzun cümle yerine tür + kısa bağlam
        return f"{TYPE_LABEL[typ]} — {title}" if len(title) <= 45 else f"{TYPE_LABEL[typ]} ❔"
    return title


def _line(e: Dict[str, Any], with_date: bool) -> str:
    mark = " ❔" if e.get("certainty") == "approximate" and not _label(e).endswith("❔") else ""
    when = ""
    if with_date:
        d = e["_d"]
        when = f" · {d.day} {AY_KISA[d.month - 1]} {GUN_KISA[d.weekday()]}"
    t = f" {e['_t']}" if e.get("_t") else ""
    tail = f" ({_left(e['_n'])})" if with_date else ""
    chg = ""
    if e.get("changed_from"):
        od = datetime.strptime(e["changed_from"], "%Y-%m-%d")
        chg = f"\n   ⚠️ tarih değişti (eskisi {od.day} {AY_KISA[od.month - 1]})"
    if e.get("weekday_mismatch"):
        chg += "\n   ⚠️ duyurudaki gün adı bu tarihle uyuşmuyor, kontrol et"
    return f"• <b>{E(e['course'])}</b> {E(_label(e))}{mark}{E(when)}{t}{tail}{chg}"


def _link(url: str, text: str = "Moodle'da aç") -> str:
    return f'<a href="{html.escape(url, quote=True)}">{E(text)}</a>' if url else ""


def free_brief(ctx: Dict[str, Any], new_items: List[Dict[str, Any]]) -> str:
    today = datetime.now(TZ)
    evs = merged_events(ctx)
    L = [f"☀️ <b>{today.day} {AY_KISA[today.month - 1]} {GUN[today.weekday()]}</b>"]

    todays = [e for e in evs if e["_n"] == 0]
    L.append("\n📌 <b>BUGÜN</b>")
    L += [f"• <b>{E(e['course'])}</b> {E(_label(e).rstrip(' ❔'))}"
          f"{' ❔' if e.get('certainty') == 'approximate' else ''}{' — ' + e['_t'] if e.get('_t') else ''}"
          for e in todays] or ["Kayıtlı bir şey yok"]

    exams = [e for e in evs if is_exam(e)][:3]
    L.append("\n🎯 <b>SINAVLAR</b>")
    L += [_line(e, True) for e in exams] or ["Kayıtlı sınav yok — syllabus'lara bir göz at"]

    week = [e for e in evs if 1 <= e["_n"] <= 7 and e not in exams]
    L.append("\n📅 <b>BU HAFTA</b>")
    if not week:
        L.append("Teslim yok")
    cur = None
    for e in week:
        d = e["_d"]
        head = f"{GUN[d.weekday()]} {d.day} {AY_KISA[d.month - 1]} ({_left(e['_n'])})"
        if head != cur:
            L.append(f"<i>{E(head)}</i>")
            cur = head
        t = f" — {e['_t']}" if e.get("_t") else ""
        mark = " ❔" if e.get("certainty") == "approximate" else ""
        warn = " ⚠️" if e.get("changed_from") or e.get("weekday_mismatch") else ""
        L.append(f"  • <b>{E(e['course'])}</b> {E(_label(e).rstrip(' ❔'))}{mark}{t}{warn}")

    # aynı duyuru birden fazla şubeye atılmışsa bir kez göster
    seen_news, uniq_items = set(), []
    for it in new_items:
        k = (it["course"], (it.get("title") or "").strip().lower(), h(it.get("text") or "")[:8] if it["kind"] != "dosya" else it["key"])
        if k in seen_news:
            continue
        seen_news.add(k)
        uniq_items.append(it)
    ann_kinds = ("duyuru", "mesaj", "duyuru cevabı")
    ann = [it for it in uniq_items if it["kind"] in ann_kinds]
    other = [it for it in uniq_items if it not in ann]
    if ann:
        L.append(f"\n📣 <b>YENİ DUYURULAR ({len(ann)})</b>")
        for it in ann:
            raw = it.get("text") or ""
            body = raw.split("\n\n", 1)[1] if raw.startswith("Gönderen:") and "\n\n" in raw else raw
            body = re.sub(r"\n{2,}", "\n", body).strip()
            cut = len(body) > 450
            body = body if not cut else body[:450].rstrip() + "…"
            upd = " (güncellendi)" if it.get("updated") else ""
            more = f"\n{_link(it.get('url', ''), 'devamı Moodle’da')}" if cut and it.get("url") else ""
            L.append(f"\n<b>{E(it['course'])} · {E(it['title'])}</b>{upd}\n{E(body)}{more}")
    if other:
        L.append(f"\n🆕 <b>DİĞER ({len(other)})</b>")
        for it in other[:25]:
            upd = " (güncellendi)" if it.get("updated") else ""
            L.append(f"• {E(it['course'])} · {E(it['kind'])}: {E(it['title'][:70])}{upd}")
        if len(other) > 25:
            L.append(f"… ve {len(other) - 25} öğe daha")
    if ctx.get("removed"):
        L.append(f"\n🗂 <b>MOODLE'DAN KALDIRILANLAR</b> <i>(arşivde duruyor)</i>")
        for x in ctx["removed"][:10]:
            L.append(f"• {E(x['course'] or '')} · {E(x['kind'] or '')}: {E((x['title'] or '')[:70])}")
    if not uniq_items:
        last = ctx.get("last_sent")
        gap = (today.date() - datetime.strptime(last, "%Y-%m-%d").date()).days if last else 1
        L.append("\n🆕 Dünden beri yeni bir şey yok" if gap <= 1 else f"\n🆕 Son {gap} günde yeni bir şey yok")
    if any(e.get("certainty") == "approximate" for e in evs if e["_n"] <= 7 or e in exams):
        L.append("\n<i>❔ = duyuru metninden çıkarıldı, teyit et</i>")
    return "\n".join(L)


# ---------------------------------------------------------------- Telegram

def tg_send(text: str, parse_mode: Optional[str] = None) -> None:
    if not (TG_TOKEN and TG_CHAT):
        raise RuntimeError("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID .env'de yok")
    chunks, cur = [], ""
    for line in text.split("\n"):
        while len(line) > 3900:
            chunks.append(cur) if cur else None
            cur = ""
            chunks.append(line[:3900])
            line = line[3900:]
        if len(cur) + len(line) + 1 > 3900:
            chunks.append(cur)
            cur = ""
        cur += line + "\n"
    if cur.strip():
        chunks.append(cur)
    for c in chunks:
        payload = {"chat_id": TG_CHAT, "text": c, "disable_web_page_preview": True}
        if parse_mode:
            payload["parse_mode"] = parse_mode
        r = _tg_post(payload)
        if r.status_code == 400 and parse_mode:
            # biçimlendirme hatası olursa düz metin olarak tekrar dene
            payload.pop("parse_mode")
            plain = re.sub(r"</?(?:b|i)>|<a [^>]*>|</a>", "", c)
            payload["text"] = html.unescape(plain)
            r = _tg_post(payload)
        if r.status_code == 401:
            raise TelegramConfigError("Telegram bot token geçersiz (BotFather'dan /revoke yaptıysan yenisini .env'e yaz)")
        if r.status_code in (400, 403) and "chat" in r.text.lower():
            raise TelegramConfigError("Bot sana mesaj atamıyor: botu engellemiş olabilirsin ya da Chat ID yanlış. "
                                      "Bota /start yazıp 'setup-telegram' komutunu tekrar çalıştır.")
        if r.status_code != 200:
            raise TransientError(f"Telegram hatası: {r.status_code} {r.text[:200]}")


class TelegramConfigError(Exception):
    pass


def _tg_post(payload: Dict[str, Any]) -> "requests.Response":
    last = None
    for attempt in range(4):
        try:
            r = requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", json=payload, timeout=30)
            if r.status_code == 429:  # çok hızlı gönderim: Telegram'ın söylediği kadar bekle
                try:
                    wait = int(r.json().get("parameters", {}).get("retry_after", 5))
                except Exception:
                    wait = 5
                time.sleep(min(wait, 60))
                continue
            if r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                last = r
                continue
            return r
        except (requests.ConnectionError, requests.Timeout) as e:
            last = e
            time.sleep(5 * (attempt + 1))
    if isinstance(last, requests.Response):
        return last
    raise TransientError(f"Telegram'a ulaşılamadı: {last}")


def setup_telegram() -> None:
    if not TG_TOKEN:
        sys.exit("Önce .env'e TELEGRAM_BOT_TOKEN yaz, sonra bota Telegram'dan herhangi bir mesaj at.")
    r = requests.get(f"https://api.telegram.org/bot{TG_TOKEN}/getUpdates", timeout=30).json()
    chats = {}
    for u in r.get("result", []):
        msg = u.get("message") or u.get("edited_message") or {}
        ch = msg.get("chat") or {}
        if ch.get("id"):
            chats[ch["id"]] = ch.get("first_name") or ch.get("title") or ""
    if not chats:
        sys.exit("Mesaj bulunamadı. Telegram'da bota /start yaz ve tekrar çalıştır.")
    cid = list(chats)[-1]
    env = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    if re.search(r"(?m)^TELEGRAM_CHAT_ID=.*$", env):
        env = re.sub(r"(?m)^TELEGRAM_CHAT_ID=.*$", f"TELEGRAM_CHAT_ID={cid}", env)
    else:
        env += f"\nTELEGRAM_CHAT_ID={cid}\n"
    ENV_FILE.write_text(env, encoding="utf-8")
    os.chmod(ENV_FILE, 0o600)
    global TG_CHAT
    TG_CHAT = str(cid)
    tg_send("✅ Moodle brifing botu bağlandı. Her sabah buraya yazacağım.")
    print(f"Chat ID {cid} ({chats[cid]}) .env'e yazıldı, test mesajı gönderildi.")


# ---------------------------------------------------------------- ana akış

def check_config(need_claude: bool = True) -> None:
    need = [("MOODLE_TOKEN", MOODLE_TOKEN), ("TELEGRAM_BOT_TOKEN", TG_TOKEN), ("TELEGRAM_CHAT_ID", TG_CHAT)]
    if not need_claude:  # 'courses' komutu sadece Moodle'a bakar
        need = need[:1]
    missing = [n for n, v in need if not v]
    if not missing:
        return
    where = ("GitHub repo → Settings → Secrets and variables → Actions → BRIEF_SECRETS secret'ına "
             "'moodle_token: ...', 'telegram_bot_token: ...', 'telegram_chat_id: ...' satırlarını ekle"
             if IN_CLOUD else "~/moodle-brief/.env")
    msg = f"Ayar eksik: {', '.join(missing)} ({where})"
    log("HATA: " + msg)  # bulutta log repoya yazılır, sebebi görülebilsin
    if TG_TOKEN and TG_CHAT:
        try:
            notify_error_once("config", f"⚠️ Moodle brifingi çalışamadı. {msg}")
        except Exception:
            pass
    sys.exit(msg)


SCHEMA = 2  # öğe sürüm biçimi değiştiğinde artar; eski kayıtlar 'güncellendi' diye yağmasın
SEND_TIME = os.getenv("SEND_TIME", "07:30")
IN_CLOUD = os.getenv("GITHUB_ACTIONS") == "true"


def _send_time_passed() -> bool:
    try:
        hh, mm = (int(x) for x in SEND_TIME.split(":"))
    except Exception:
        hh, mm = 7, 30
    n = datetime.now(TZ)
    return (n.hour, n.minute) >= (hh, mm)


def _acquire_lock():
    """Aynı anda iki çalıştırma (zamanlayıcı + elle) state dosyasını bozmasın."""
    import fcntl
    DATA_DIR.mkdir(exist_ok=True)
    f = open(DATA_DIR / "run.lock", "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return None
    return f


def notify_error_once(kind: str, text: str) -> None:
    """Aynı hatayı günde bir kez bildir (zamanlayıcı her 30 dk'da bir dener, telefonun dolmasın)."""
    st = load_state()
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    le = st.get("last_error") or {}
    if le.get(kind) == today:
        return
    try:
        tg_send(text)
        le[kind] = today
        st["last_error"] = le
        save_state(st)
    except Exception as e:
        log(f"Hata bildirimi de gönderilemedi: {e}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Moodle sabah brifingi")
    ap.add_argument("cmd", nargs="?", default="run", choices=["run", "test", "init", "courses", "setup-telegram"])
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--scheduled", action="store_true",
                    help="zamanlayıcıdan çağrıldı: gönderim saati gelmediyse ya da bugün gönderildiyse sessizce çık")
    args = ap.parse_args()
    rotate_log()
    main.scheduled = args.scheduled  # hata yakalayıcı için

    if args.cmd == "setup-telegram":
        return setup_telegram()

    m = Moodle(MOODLE_URL, MOODLE_TOKEN)
    if args.cmd == "courses":
        check_config(need_claude=False)
        uid = m.call("core_webservice_get_site_info")["userid"]
        act = {c["id"] for c in active_courses(m, uid)}
        for c in m.call("core_enrol_get_users_courses", userid=uid):
            mark = "✔ taranıyor" if c["id"] in act else "  "
            print(f"{mark}  id={c['id']:<7} {c.get('shortname')} — {c.get('fullname')}")
        print("\nListeyi elle belirlemek için .env'de COURSE_IDS=123,456 veya EXCLUDE_COURSE_IDS=789 kullan.")
        return

    check_config()
    state = load_state()
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    if args.cmd == "run" and state.get("last_sent_date") == today and not args.force:
        if not args.scheduled:
            log("Bugünün brifingi zaten gönderildi, çıkılıyor.")
        return
    if args.scheduled and not _send_time_passed():
        return  # henüz gönderim saati değil
    if args.scheduled and not IN_CLOUD and (BASE_DIR / "CLOUD_ACTIVE").exists():
        return  # brifing artık GitHub'dan gidiyor; Mac'teki kopya çift mesaj atmasın
    lock = _acquire_lock()
    if lock is None:
        log("Başka bir çalıştırma sürüyor, çıkılıyor.")
        return
    state = load_state()  # kilitten sonra güncel hali oku
    if args.cmd == "run" and state.get("last_sent_date") == today and not args.force:
        return

    first_run = not state["seen"]
    migrating = bool(state["seen"]) and state.get("schema") != SCHEMA
    if migrating:
        log("Kayıt biçimi güncellendi: bu çalıştırmada sadece gerçekten yeni öğeler 'yeni' sayılacak.")
    data = collect(m, state.get("reply_cache"))
    rc = state.setdefault("reply_cache", {})
    rc.update(data["reply_cache"])  # eski kayıtlar korunur, sadece güncellenir
    cl = None if FREE_MODE else Claude(ANTHROPIC_API_KEY)
    log(f"Mod: {'ücretsiz (Claude yok)' if FREE_MODE else 'Claude'}")
    now = int(time.time())

    # yeni / değişmiş öğeler
    new_items = []
    for it in data["items"]:
        prev = state["seen"].get(it["key"])
        if prev == it["version"]:
            continue
        if first_run or args.cmd == "init":
            if it.get("time") and it["time"] > now - 7 * 86400:
                new_items.append(it)
        elif migrating:
            if prev is None and (not it.get("time") or it["time"] > now - 3 * 86400):
                new_items.append(it)  # sürüm biçimi değişti diye eski öğeleri 'güncellendi' sayma
        else:
            it["updated"] = prev is not None
            new_items.append(it)

    # içerik çıkarımı (değişen her şey, ilk çalıştırmada her şey)
    todo = [it for it in data["items"]
            if it["kind"] != "takvim" or it.get("extract")]
    todo = [it for it in todo
            if (state["extracted"].get(it["key"], {}).get("version"), state["extracted"].get(it["key"], {}).get("mode"))
            != (it["version"], MODE)]
    log(f"{len(todo)} öğe okunacak/özetlenecek")
    for i, it in enumerate(todo, 1):
        try:
            ex = free_extract(it) if FREE_MODE else extract_item(m, cl, it, data["courses"])
        except Exception as e:
            log(f"Çıkarım hatası {it['key']}: {e}")
            continue
        ex.update({"version": it["version"], "course": it["course"], "title": it["title"], "kind": it["kind"],
                   "mode": MODE, "posted": it.get("time") or _key_num(it["key"])})
        prev = state["extracted"].get(it["key"])
        hist = list((prev or {}).get("previous_versions", []))
        if prev and prev.get("version") != it["version"]:
            # içerik değişti: eski sürümün tarihleri kayıtta kalır (silinmez), sadece gösterilmez
            hist.append({"version": prev.get("version"), "posted": prev.get("posted"),
                         "events": prev.get("events", []), "replaced_at": now})
        ex["previous_versions"] = hist
        state["extracted"][it["key"]] = ex
        if i % 10 == 0:
            save_state(state)
            log(f"  {i}/{len(todo)}")

    # Her öğenin her sürümü arşive bir kez eklenir (append-only)
    archived = state.setdefault("archived", {})
    for it in data["items"]:
        if archived.get(it["key"]) != it["version"]:
            archive(it, state["extracted"].get(it["key"]))
            archived[it["key"]] = it["version"]
    save_state(state)

    # HİÇBİR KAYIT SİLİNMEZ. Moodle'dan kalkmış (hoca silmiş/gizlemiş) öğeler sadece GÖSTERİLMEZ.
    # Tek seferlik okunamama yüzünden gizlenmesin diye: uyarısız 3 çalıştırma üst üste yoksa gizlenir,
    # tekrar görünürse geri gelir.
    live = {it["key"] for it in data["items"]}
    missing = state.setdefault("missing", {})
    newly_hidden = []
    # Sadece içerik okuyan bir bölüm GEÇİCİ olarak okunamadıysa gizleme yapılmaz. Kalıcı kapalı özellikler
    # (örn. mesajlaşması 'disabled' olan siteler) ya da içerikle ilgisiz uyarılar bu kuralı durdurmaz.
    content_fns = ("core_course_get_contents", "mod_forum_", "mod_assign_", "mod_quiz_", "core_calendar_")
    content_blocked = any(w.startswith(content_fns) and "disabled" not in w.lower() for w in WARNINGS)
    for k, ex in state["extracted"].items():
        if k in live:
            missing.pop(k, None)
            ex.pop("hidden", None)
        elif not content_blocked:
            missing[k] = missing.get(k, 0) + 1
            if missing[k] >= 3 and not ex.get("hidden"):
                ex["hidden"] = True
                if ex.get("kind") in ("duyuru", "duyuru cevabı", "ödev", "quiz") or ex.get("events"):
                    newly_hidden.append(ex)

    for it in new_items:
        log(f"YENİ: [{it['course']}] {it['kind']}: {it['title']}")

    ctx = build_context(data, state, new_items)
    ctx["removed"] = [{"course": x.get("course"), "kind": x.get("kind"), "title": x.get("title")} for x in newly_hidden]
    is_html = True
    if FREE_MODE:
        brief = free_brief(ctx, new_items)
    else:
        try:
            brief = cl.ask(BRIEF_MODEL, BRIEF_SYSTEM, json.dumps(ctx, ensure_ascii=False), 2500).strip()
            brief += "\n" + footer(new_items)
            is_html = False
        except Exception as e:
            log(f"Brifing yazılamadı: {e}")
            brief = free_brief(ctx, new_items)
    # API uyarıları sadece log'a ve test/init çıktısına; günlük mesajı kirletmesin
    warn = ("\n\n🔧 Moodle'ın izin vermediği bölümler (normal olabilir): "
            + "; ".join(w.split(" çalışmadı")[0] for w in WARNINGS)) if WARNINGS else ""

    if args.cmd in ("test", "init"):
        shown = re.sub(r"</?[bi]>", "", brief) if is_html else brief
        shown = html.unescape(shown) if is_html else shown
        print("\n" + "=" * 60 + "\n" + shown + warn + "\n" + "=" * 60)
        if args.cmd == "init":
            for it in data["items"]:
                state["seen"][it["key"]] = it["version"]
            state["last_run_ts"] = now
            state["schema"] = SCHEMA
            save_state(state)
            print("\nİlk tarama tamam. Bundan sonra sadece yeni öğeler 'YENİ' olarak gelecek.")
        else:
            save_state(state)
        return

    n = datetime.now(TZ)
    if args.scheduled and n.hour >= 12 and not IN_CLOUD:
        brief = brief.replace("</b>", f"</b> <i>(geç geldi: Mac {SEND_TIME}'da kapalı/uykudaydı)</i>", 1) \
            if is_html else brief + f"\n(geç geldi: Mac {SEND_TIME}'da kapalıydı)"
    tg_send(brief, parse_mode="HTML" if is_html else None)
    for it in data["items"]:
        state["seen"][it["key"]] = it["version"]
    state["last_sent_date"] = today
    state["last_run_ts"] = now
    state["schema"] = SCHEMA
    state["last_error"] = {}
    save_state(state)
    log("Brifing gönderildi.")


def entry() -> None:
    try:
        main()
    except SystemExit:
        raise
    except TokenError as e:
        log(f"HATA (token): {e}")
        notify_error_once("token", "⚠️ Moodle brifingi çalışamadı: Moodle token'ı geçersiz ya da süresi dolmuş.\n"
                          "Moodle → Preferences → Security keys → 'Moodle mobile web service' satırındaki key'i "
                          "kopyalayıp ~/moodle-brief/.env dosyasındaki MOODLE_TOKEN satırına yapıştır.")
        sys.exit(1)
    except TelegramConfigError as e:
        log(f"HATA (telegram): {e}")  # Telegram'a zaten ulaşılamıyor, sadece log
        sys.exit(1)
    except TransientError as e:
        log(f"Geçici hata (sonra tekrar denenecek): {e}")
        # zamanlayıcı 30 dk'da bir tekrar dener; öğlene kadar hâlâ olmuyorsa bir kez haber ver
        if not getattr(main, "scheduled", False) or datetime.now(TZ).hour >= 12:
            notify_error_once("transient", f"⚠️ Moodle brifingi henüz gönderilemedi: Moodle'a ya da internete "
                                           f"ulaşılamıyor ({str(e)[:150]}). Bağlantı gelince otomatik denenecek.")
        # zamanlanmış çalıştırmada 0 ile çık: bir sonraki deneme zaten planlı, GitHub her seferinde hata maili atmasın
        sys.exit(0 if getattr(main, "scheduled", False) else 1)
    except Exception as e:
        log("HATA: " + "".join(traceback.format_exception_only(type(e), e)).strip())
        log(traceback.format_exc())
        notify_error_once("other", f"⚠️ Moodle brifingi çalışmadı: {type(e).__name__}: {str(e)[:300]}\n"
                                   f"Ayrıntı: ~/moodle-brief/data/log.txt")
        sys.exit(1)


if __name__ == "__main__":
    entry()
