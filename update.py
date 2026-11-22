#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
update.py - يجلب أحدث المنح الدراسية من مصادر RSS موثوقة ويحدّث الموقع.

يشغّل يدوياً بـ:  python3 update.py
أو تلقائياً عبر GitHub Actions (الملف .github/workflows/update.yml).

يعيد بناء index.html مع تضمين البيانات الجديدة وتاريخ التحديث الفعلي.
"""
import json
import re
import ssl
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "template.html"
OUT = HERE / "index.html"

# مصادر RSS تم التحقق من أنها تعمل. المصادر التي تحجب الزحف الآلي
# (مثل Opportunity Desk) غير مدرجة لأنها تعطي 403 للطلبات الآلية.
FEEDS = [
    ("Scholars4Dev", "https://www.scholars4dev.com/feed/"),
    ("Opportunities Corners", "https://www.opportunitiescorners.com/feed/"),
    ("Mladiinfo", "https://www.mladiinfo.eu/feed/"),
    ("Greatyop", "https://www.greatyop.com/feed/"),
    ("Opportunities for Africans", "https://www.opportunitiesforafricans.com/feed/"),
]

# الموقع موجّه للطلاب الفلسطينيين: لا يدخل صفحة الفهرس من تجميع المصادر
# إلا ما يذكر فلسطين صراحة (عنوانا أو نصا أو أهلية منقولة من صفحة المصدر)،
# إضافة إلى المنح المُتحقق منها يدويا في curated.json.
PALESTINE_RE = re.compile(r"palestin|\u0641\u0644\u0633\u0637\u064a\u0646", re.I)
CURATED_FILE = HERE / "curated.json"

# رابط النسخة المنشورة من لوحة التحكم (Cloudflare Worker). يُفعّل بملء الرابط
# بعد نشر اللوحة؛ عندما يكون فارغا يعمل الموقع كما كان (curated + اكتشاف تلقائي).
DASHBOARD_URL = "https://ibn-alhaytham-admin.yafoozeaslan.workers.dev/scholarships.json"

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 scholarship-site-updater"
MAX_ITEMS_PER_FEED = 25
TIMEOUT = 30

DEGREE_MAP = [
    (r"\bph\.?d\b|doctoral|doctorate", "دكتوراه"),
    (r"\bmaster'?s?\b|msc\b|mba\b|ماجستير", "ماجستير"),
    (r"\bbachelor'?s?\b|undergraduate|bsc\b|بكالوريوس", "بكالوريوس"),
    (r"\bfellowship", "زمالة"),
    (r"\bexchange\b|تبادل", "تبادل ثقافي"),
    (r"\bshort[\s-]?course|training programme|training program", "دورة تدريبية"),
]

# الموقع مخصّص للمنح الدراسية فقط: نُبقي ما يُعلن كمنحة دراسية،
# ونستبعد الوظائف والتدريبات والمسابقات وبرامج الأعمال.
KEEP_RE = re.compile(
    r"scholarship|bursar|studentship|tuition|scholars (programme|program)|"
    r"study (grant|award)|\u0645\u0646\u062d\u0629|\u0645\u0646\u062d \u062f\u0631\u0627\u0633\u064a\u0629",
    re.I,
)
DROP_RE = re.compile(
    r"internship|vacanc|\bjob\b|career|traineeship|graduate trainee|consulting|"
    r"accelerator|incubator|entrepreneur|start[ -]?up|essay|competition|contest|"
    r"\bprize|\baward\b|summit|conference|bootcamp|hackathon|volunteer|"
    r"fellowship|advisory board|ambassador|business innovation",
    re.I,
)
# مقالات تجميعية (قوائم منح) وليست منحة محددة واحدة
LISTICLE_RE = re.compile(
    r"^\s*\d+\+?\s|\btop \d+\b|\blist of\b|\b\d+\s+(new\s+)?scholarships\b",
    re.I,
)
# جمل المميزات/التمويل داخل نص الإعلان
BENEFIT_RE = re.compile(
    r"fully[ -]?funded|tuition|stipend|allowance|accommodation|airfare|travel grant|"
    r"health insurance|living (costs|expenses|allowance)|monthly|covers? (all|tuition|the)|"
    r"\u0645\u0645\u0648\u0644\u0629|\u062a\u063a\u0637\u064a",
    re.I,
)

DEADLINE_RE = re.compile(
    r"\b[Dd]eadlines?\s*[:\-]?\s*(?:is\s+|are\s+)?"
    r"((?:\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|annual|yearly)"
    r"[A-Za-z0-9,/\.\-\s]{2,50}?(?:\d{4}|annual|yearly))",
    re.I,
)
STUDY_IN_RE = re.compile(r"[Ss]tudy in[:\s]+([A-Za-z\s\.,\(\)/&]{3,50}?)(?:\.|<|\||$)")
FUNDED_RE = re.compile(r"[Ff]ully[\s-]?[Ff]unded|ممولة بالكامل")

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\ufeff]")


BOILER_RE = re.compile(r"The post .{0,160}?appeared first on[^.]*\.?", re.I)


def clean(text, limit=220):
    if not text:
        return ""
    text = ZERO_WIDTH_RE.sub("", unescape(TAG_RE.sub(" ", text)))
    text = BOILER_RE.sub(" ", text)
    text = re.sub(r"\s*The post .{0,250}$", "", text)
    text = text.replace("[\u2026]", "\u2026")
    text = WS_RE.sub(" ", text).strip()
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0] + "…"
    return text


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
        return r.read()


def parse_feed(xml_bytes):
    """يدعم RSS 2.0 و Atom. يعيد قائمة عناصر خام."""
    root = ET.fromstring(xml_bytes)
    items = []
    # RSS 2.0
    for it in root.iter("item"):
        def t(tag):
            el = it.find(tag)
            return el.text.strip() if el is not None and el.text else ""
        items.append({
            "title": t("title"),
            "link": t("link"),
            "date": t("pubDate") or t("date"),
            "desc": t("description"),
        })
    # Atom
    if not items:
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for it in root.iter("{http://www.w3.org/2005/Atom}entry"):
            link = ""
            for le in it.findall("a:link", ns):
                if le.get("rel", "alternate") == "alternate":
                    link = le.get("href", "")
                    break
            date = it.findtext("a:published", "", ns) or it.findtext("a:updated", "", ns)
            items.append({
                "title": (it.findtext("a:title", "", ns) or "").strip(),
                "link": link,
                "date": date.strip(),
                "desc": it.findtext("a:summary", "", ns) or it.findtext("a:content", "", ns) or "",
            })
    return items


def parse_date(raw):
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw).astimezone(timezone.utc)
    except Exception:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(raw.strip(), fmt)
            return dt.replace(tzinfo=timezone.utc)
        except Exception:
            continue
    return None


def extract_degrees(text):
    out = []
    for pat, label in DEGREE_MAP:
        if re.search(pat, text) and label not in out:
            out.append(label)
    return out[:3]


def is_scholarship(item):
    title = clean(item["title"], 300)
    blob = title + " " + (item["desc"] or "")
    if LISTICLE_RE.search(title):
        return False
    return bool(KEEP_RE.search(blob)) and not DROP_RE.search(title)


ELIGIBILITY_RE = re.compile(
    r"eligible (for|to|countries|nationalit)|open to|nationalit|citizen|"
    r"who can apply|can apply|international students|"
    r"\u0645\u0624\u0647\u0644|\u0627\u0644\u0623\u0647\u0644\u064a\u0629|\u0634\u0631\u0648\u0637",
    re.I,
)
ARTICLE_RE = re.compile(r"<article\b[^>]*>(.*?)</article>", re.S | re.I)
CONTENT_DIV_RE = re.compile(
    r'<div[^>]*class="[^"]*(?:entry-content|post-content|article-content|td-post-content)[^"]*"[^>]*>(.*)',
    re.S | re.I,
)
SECTION_END_RE = re.compile(
    r'<div[^>]*class="[^"]*(?:related|post-nav|comments|sharedaddy)[^"]*"',
    re.I,
)
ORD_RE = re.compile(r"(\d+)(?:st|nd|rd|th)\b", re.I)
DATE_PATTERNS = [
    re.compile(r"(\d{1,2})\s+(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\.?,?\s+(\d{4})", re.I),
    re.compile(r"(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\.?\s+(\d{1,2}),?\s+(\d{4})", re.I),
]
MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
SCRIPT_STYLE_RE = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)


def parse_dates(s):
    out = []
    for pat in DATE_PATTERNS:
        for m in pat.finditer(s):
            g = m.groups()
            if g[0][0].isdigit():
                d, mon, y = int(g[0]), MONTHS.get(g[1][:3].lower()), int(g[2])
            else:
                mon, d, y = MONTHS.get(g[0][:3].lower()), int(g[1]), int(g[2])
            if mon:
                out.append((y, mon, d))
    return out


def norm_deadline(raw, limit=70):
    s = ORD_RE.sub(r"\1", clean(raw, 200)).strip(" ,./\u2026")
    return s[:limit] or None


def fetch_page_text(url):
    """يجلب صفحة المصدر ويعيد نص المقال المنظّف، أو None عند الفشل."""
    try:
        raw = fetch(url).decode("utf-8", errors="replace")
    except Exception as e:
        print(f"    [page fail] {url}: {e}", file=sys.stderr)
        return None
    raw = SCRIPT_STYLE_RE.sub(" ", raw)
    m = ARTICLE_RE.search(raw)
    if m:
        raw = m.group(1)
    else:
        m = CONTENT_DIV_RE.search(raw)
        if m:
            raw = SECTION_END_RE.split(m.group(1))[0]
    return clean(raw, 20000)


JUNK_RE = re.compile(
    r"\bHome\b|Facebook|Instagram|Linkedin|Twitter|Youtube|Contact Us|"
    r"Scholarships in |Privacy Policy|Copyright|All Rights Reserved|Subscribe|"
    r"personal experiences|About the Author|\bI (therefore|created|founded|started)\b|"
    r"^\w+ \d{1,2}, \d{4}\s|\bBy [A-Z][a-z]+ [A-Z][a-z]+\b|^Brief description",
    re.I,
)


def extract_sentences(text, pattern, limit=5, minlen=25, maxlen=300):
    out = []
    for sent in re.split(r"(?<=[.!\u061f])\s+", text):
        sent = sent.strip()
        if not sent or len(sent) < minlen or len(sent) > maxlen:
            continue
        if JUNK_RE.search(sent) or not pattern.search(sent):
            continue
        out.append(sent[:250])
        if len(out) >= limit:
            break
    return out


def enrich(item):
    """يسحب التفاصيل من صفحة المنحة نفسها: الموعد، المستوى، المميزات، الأهلية."""
    text = fetch_page_text(item["link"])
    if not text:
        item.setdefault("benefits", [])
        item.setdefault("eligibility", [])
        item["details_from"] = "rss"
        return item
    item["details_from"] = "page"
    # نفضّل الموعد من ملخّص المُعلِن (RSS)، ونستخدم نص الصفحة فقط عند غيابه
    if not item.get("deadline"):
        m = DEADLINE_RE.search(text)
        if m:
            item["deadline"] = norm_deadline(m.group(1))
    m = STUDY_IN_RE.search(text)
    if m and not item.get("study_in"):
        item["study_in"] = clean(m.group(1), 60)
    benefits = extract_sentences(text, BENEFIT_RE, limit=5)
    if benefits:
        item["benefits"] = benefits
    else:
        item.setdefault("benefits", [])
    elig = extract_sentences(text, ELIGIBILITY_RE, limit=3)
    item["eligibility"] = [e for e in elig if e not in item["benefits"]]
    return item


def normalize(item, source):
    title = clean(item["title"], 300)
    blob = item["title"] + " " + (item["desc"] or "")
    deadline = None
    m = DEADLINE_RE.search(blob)
    if m:
        deadline = norm_deadline(m.group(1))
    study_in = None
    m = STUDY_IN_RE.search(blob)
    if m:
        study_in = clean(m.group(1), 50).rstrip(" ,.-")
    return {
        "title": title,
        "link": item["link"].strip(),
        "source": source,
        "published": (parse_date(item["date"]) or datetime.now(timezone.utc)).isoformat(),
        "summary": clean(item["desc"], 350),
        "deadline": deadline,
        "study_in": study_in,
        "degrees": extract_degrees(blob),
        "fully_funded": bool(FUNDED_RE.search(blob)),
        "benefits": [],
        "eligibility": [],
        "details_from": "rss",
    }


def main():
    seen = set()
    results = []
    errors = []
    for name, url in FEEDS:
        try:
            items = parse_feed(fetch(url))
            count = 0
            kept = skipped = 0
            for it in items:
                key = (it["title"].strip().lower(), it["link"].strip())
                if not it["title"].strip() or key in seen:
                    continue
                seen.add(key)
                if not is_scholarship(it):
                    skipped += 1
                    continue
                blob = it["title"] + " " + (it["desc"] or "")
                if not PALESTINE_RE.search(blob):
                    skipped += 1
                    continue
                results.append(normalize(it, name))
                kept += 1
                if kept >= MAX_ITEMS_PER_FEED:
                    break
            print(f"[ok] {name}: {kept} scholarships kept, {skipped} non-scholarship items skipped")
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"[fail] {name}: {e}", file=sys.stderr)
        time.sleep(1)  # لطف بالمصادر

    # إثراء كل منحة من صفحتها على المصدر
    for it in results:
        enrich(it)
        time.sleep(1)
    enriched = sum(1 for it in results if it["details_from"] == "page")
    print(f"enriched from source pages: {enriched}/{len(results)}")

    # تحقق ثان بعد الإثراء: لو نص صفحة المصدر نفسها لا يذكر فلسطين، نستبعد العنصر
    before = len(results)
    results = [
        it for it in results
        if PALESTINE_RE.search(
            it["title"] + " " + (it["summary"] or "") + " "
            + " ".join(it["benefits"]) + " " + " ".join(it["eligibility"])
        )
    ]
    dropped = before - len(results)
    if dropped:
        print(f"dropped after enrichment (no Palestine mention on source page): {dropped}")

    # مصدر الحقيقة: لوحة التحكم (إن كانت مفعّلة). نجلب نسختها المنشورة
    # ونحترم حذف المستخدم (tombstones) فلا تُحيى منحة حذفها من الاكتشاف التلقائي.
    # لو تعذّر جلب اللوحة: لا نغيّر المحتوى إطلاقا ونخرج دون التزام.
    managed = None
    tombstones = set()
    if DASHBOARD_URL:
        try:
            raw = fetch(DASHBOARD_URL)
            payload = json.loads(raw.decode("utf-8"))
            managed = payload.get("items", [])
            tombstones = set(payload.get("deleted", []))
            print(f"dashboard: {len(managed)} managed items, {len(tombstones)} tombstones")
        except Exception as e:
            print(f"[dashboard fail] {DASHBOARD_URL}: {e} — leaving site unchanged", file=sys.stderr)
            return
    # استبعاد المكتشف تلقائيا الذي حذفه المستخدم من اللوحة
    if tombstones:
        before = len(results)
        results = [it for it in results if it["link"] not in tombstones]
        dropped = before - len(results)
        if dropped:
            print(f"skipped auto items deleted by user: {dropped}")

    # دمج المنح المُتحقق منها يدويا (تتجاوز المرشح لأن أهليتها موثقة من مصدرها)
    if CURATED_FILE.exists():
        curated = json.loads(CURATED_FILE.read_text(encoding="utf-8"))
        existing = {it["link"] for it in results}
        added = 0
        for c in curated:
            if c["link"] in existing or c["link"] in tombstones:
                continue
            c.setdefault("details_from", "curated")
            results.append(c)
            added += 1
        print(f"curated items merged: {added} of {len(curated)}")

    # عناصر اللوحة تسبق أي مصدر آخر: تعديلات المستخدم وحالاته اليدوية
    if managed:
        by_link = {it["link"]: it for it in results}
        replaced = added = 0
        for m in managed:
            m.setdefault("details_from", "dashboard")
            if m["link"] in by_link:
                by_link[m["link"]].update(m)
                replaced += 1
            else:
                results.append(m)
                added += 1
        print(f"dashboard items applied: {replaced} updated, {added} added")

    # وسم المنح المنتهية: كل مواعيدها المنقولة في الماضي
    today = datetime.now(timezone.utc).date()
    today = (today.year, today.month, today.day)
    for it in results:
        dates = parse_dates(it["deadline"] or "")
        it["closed"] = bool(dates) and max(dates) < today
        # حالة العرض: مفتوحة الآن، تفتح قريبا بموعد مؤكد، لم يُعلن موعدها، مغلقة
        if "status" not in it:
            it["status"] = "closed" if it["closed"] else "open"
        if it["status"] == "closed":
            it["closed"] = True
    STATUS_RANK = {"open": 0, "upcoming": 1, "unannounced": 2, "closed": 3}
    results.sort(key=lambda x: x["published"], reverse=True)
    results.sort(key=lambda x: STATUS_RANK.get(x["status"], 0))
    now = datetime.now(timezone.utc).isoformat()

    tpl = TEMPLATE.read_text(encoding="utf-8")
    payload = json.dumps({"updated": now, "count": len(results), "items": results},
                         ensure_ascii=False)
    html = tpl.replace("/*__DATA__*/null", payload, 1)
    OUT.write_text(html, encoding="utf-8")
    print(f"built {OUT.name}: {len(results)} scholarships, updated {now}")
    if errors:
        print("sources with errors:", "; ".join(errors))
    if results:
        print("newest:", results[0]["title"][:90])
        print("oldest:", results[-1]["title"][:90])


if __name__ == "__main__":
    main()
