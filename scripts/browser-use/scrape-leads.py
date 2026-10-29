# Lead extraction, executed by browser-use (helpers pre-imported, incl. elements/safe_click/click_text).
# Parameters arrive as env vars — nothing from a page or a caller is ever spliced into code.
#   SL_URLS       newline-separated start URLs (required)
#   SL_FOLLOW     comma-separated keywords; same-site links whose text or path contains one are
#                 followed ("" = do not follow)
#   SL_MAX_PAGES  total pages to read, across starts, follows and pagination (default 6)
#   SL_NEXT       visible text of a directory's pagination control, e.g. "Next" (optional)
#   SL_DELAY      seconds between page loads (default 1.5)
# Prints exactly one JSON line prefixed SL_RESULT=.
#
# DETERMINISTIC ON PURPOSE. No model decides what a person is: schema.org data, then repeated
# "team card" blocks, then loose mailto:/tel: links. Every field carries HOW it was found, so a
# wrong extraction is visible in the output instead of looking exactly like a right one.
import json
import os
import time
import urllib.parse
import urllib.request
import urllib.robotparser

UA = "IRIS-ReachR/1.0 (+https://heyiris.io)"
starts = [u.strip() for u in os.environ.get("SL_URLS", "").splitlines() if u.strip()]
follow = [k.strip().lower() for k in os.environ.get("SL_FOLLOW", "").split(",") if k.strip()]
max_pages = int(os.environ.get("SL_MAX_PAGES", "6") or 6)
next_text = os.environ.get("SL_NEXT", "").strip()
delay = float(os.environ.get("SL_DELAY", "1.5") or 1.5)

_robots = {}


def robots_allows(url):
    """robots.txt says whether WE may read this page. An unreachable robots.txt is treated as
    allowing (the web's convention), a 401/403 on it as disallowing everything."""
    p = urllib.parse.urlparse(url)
    root = f"{p.scheme}://{p.netloc}"
    if root not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(root + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                rp.parse(r.read().decode("utf-8", "replace").splitlines())
        except urllib.error.HTTPError as e:
            rp.disallow_all = e.code in (401, 403)
            rp.allow_all = not rp.disallow_all
        except Exception:
            rp.allow_all = True
        _robots[root] = rp
    return _robots[root].can_fetch(UA, url)


# The extractor is shared with the Playwright engine (scrape-leads.js), so it lives in one file.
# scrape-leads.sh passes its path; this script arrives on stdin and has no __file__ of its own.
with open(os.environ["SL_EXTRACT_FILE"], encoding="utf-8") as _f:
    EXTRACT_JS = _f.read()


result = {"measured": False, "pages": [], "leads": [], "contacts": [], "skipped": []}
queue = list(starts)
visited, lead_keys = set(), set()
read = 0


def take(page):
    for p in page["people"]:
        key = ((p.get("email") or {}).get("v") or p["name"]["v"]).lower()
        if key in lead_keys:
            continue
        lead_keys.add(key)
        p["company"] = p.get("company") or page["company"]
        p["company_how"] = page["company_how"] if not p.get("company") or p["company"] == page["company"] else "json-ld"
        p["source_url"] = page["url"]
        result["leads"].append(p)
    for c in page["contacts"]:
        if any(x["value"] == c["value"] for x in result["contacts"]):
            continue
        c["company"] = page["company"]
        c["source_url"] = page["url"]
        result["contacts"].append(c)


def read_page(url, how):
    global read
    if not robots_allows(url):
        result["skipped"].append({"url": url, "reason": "robots.txt disallows it"})
        return None
    if read > 0:
        time.sleep(delay)                 # polite by default — and it is the site's server, not ours
    read += 1
    try:
        goto_url(url)                     # noqa: F821 — browser-harness helper
        wait_for_load(timeout=30)         # noqa: F821
    except Exception as e:
        result["pages"].append({"url": url, "how": how, "error": f"did not load ({type(e).__name__})"})
        return None
    page = js(EXTRACT_JS)                 # noqa: F821
    if not page["status"]:
        result["pages"].append({"url": url, "how": how, "error": "did not load (unreachable, DNS, TLS or refused)"})
        return None
    result["pages"].append({"url": page["url"], "how": how, "status": page["status"],
                            "people": len(page["people"]), "contacts": len(page["contacts"])})
    take(page)
    return page


new_tab("about:blank")                    # noqa: F821
while queue and read < max_pages:
    url = queue.pop(0)
    norm = url.split("#")[0].rstrip("/")
    if norm in visited:
        continue
    visited.add(norm)
    page = read_page(url, "start" if url in starts else "follow")
    if not page:
        continue

    # Pagination: click the directory's own "Next" control — through safe_click, so a Next that
    # is covered, ambiguous or dead stops the crawl instead of paging the wrong list.
    while next_text and read < max_pages:
        try:
            r = click_text(next_text, exact=True)   # noqa: F821 — IRIS agent helper
        except Exception as e:
            result["pages"][-1]["pagination_stopped"] = str(e)[:120]
            break
        if not r["changed"]:
            result["pages"][-1]["pagination_stopped"] = "Next did not change the page"
            break
        read += 1
        time.sleep(delay)
        page = js(EXTRACT_JS)             # noqa: F821
        visited.add(page["url"].split("#")[0].rstrip("/"))
        result["pages"].append({"url": page["url"], "how": "next", "status": page["status"],
                                "people": len(page["people"]), "contacts": len(page["contacts"])})
        take(page)

    if follow:
        for l in page["links"]:
            hay = (l["text"] + " " + urllib.parse.urlparse(l["href"]).path).lower()
            if any(k in hay for k in follow) and l["href"].split("#")[0].rstrip("/") not in visited:
                queue.append(l["href"])

loaded = [p for p in result["pages"] if not p.get("error")]
result["measured"] = bool(loaded)
if not loaded:
    reasons = [p.get("error") for p in result["pages"]] + [s["reason"] for s in result["skipped"]]
    result["error"] = "; ".join(sorted(set(r for r in reasons if r))) or "no page could be read"
result["counts"] = {
    "pages": len(loaded),
    "leads": len(result["leads"]),
    "with_email": sum(1 for p in result["leads"] if p.get("email")),
    "with_phone": sum(1 for p in result["leads"] if p.get("phone")),
    "with_social": sum(1 for p in result["leads"] if p.get("socials")),
    "company_contacts": len(result["contacts"]),
}
result["ok"] = result["measured"] and bool(result["leads"] or result["contacts"])
print("SL_RESULT=" + json.dumps(result))
