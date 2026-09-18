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


EXTRACT_JS = r"""
(() => {
  const STOP = new Set(('contact about team our read more learn get started privacy policy terms home ' +
    'services careers blog news login sign menu search view all meet the leadership board staff members ' +
    'directors management company inc llc group us welcome join book call now free trial pricing ' +
    'features products solutions resources support help faq click here see profile bio follow').split(' '));
  const PARTICLE = new Set(['de','van','von','da','del','la','le','bin','al','di','du','der','den','y']);
  // Honorifics and post-nominals are stripped before counting — "Dr. Priya van der Berg" is a
  // two-name person with a title and two particles, and the first version rejected it as five
  // words. Internal capitals are allowed (O'Neil, McDonald, Jean-Luc): the first version
  // required lower-case after the initial and dropped every one of them.
  const HONOR = /^(dr|mr|mrs|ms|mx|prof|sir|rev|hon)\.?$/i;
  const POST = /^(md|dds|dmd|phd|jd|esq|cpa|rn|np|pa|mba|jr|sr|ii|iii|iv)\.?,?$/i;
  const cleanName = s => (s || '').replace(/\s+/g, ' ').trim().replace(/,.*$/, '');
  // A JOB TITLE IS NAME-SHAPED. "Lead Dentist", "Practice Manager", "General Partner" all pass as
  // First Last — so every card looked like it held two people, collapsed to the bare heading, and
  // lost its evidence. That is why the fixture dropped Maria and James, and why YC returned 29 of
  // ~100: only people whose title was NOT name-shaped ("President & CEO") survived. Any whole-word
  // role token disqualifies a name. (Surnames that are also trades — Baker, Cook, Taylor — are
  // deliberately NOT in this list.)
  const ROLE_TOKENS = new Set(('ceo cto cfo coo cmo founder cofounder co-founder partner partners director manager president ' +
    'vice head lead chief officer owner principal associate engineer designer dentist doctor physician attorney lawyer ' +
    'counsel agent broker advisor adviser consultant analyst specialist coordinator assistant professor teacher nurse ' +
    'therapist surgeon orthodontist hygienist chair chairman chairwoman member editor writer producer artist coach ' +
    'recruiter representative sales marketing operations executive investor fellow scientist researcher general senior ' +
    'junior staff administrator secretary treasurer trustee emeritus retired intern practice office').split(' '));
  const isName = s => {
    s = cleanName(s);
    if (s.length < 4 || s.length > 48 || /\d|@|http/.test(s)) return false;
    const w = s.split(' ').filter(t => !HONOR.test(t) && !POST.test(t));
    if (w.length < 2 || w.length > 6) return false;
    let real = 0;
    for (const t of w) {
      const lt = t.toLowerCase().replace(/[.,]$/, '');
      if (STOP.has(lt) || ROLE_TOKENS.has(lt)) return false;
      if (PARTICLE.has(lt)) continue;
      if (!/^[A-ZÀ-Þ][A-Za-zÀ-ÿ'’\-]*\.?$/.test(t) || !/[a-zà-ÿ]/.test(t)) {
        if (!/^[A-Z]\.$/.test(t)) return false;              // a bare initial "J." is fine
      }
      real++;
    }
    return real >= 2 && real <= 4;
  };
  const txt = el => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  const abs = h => { try { return new URL(h, location.href).href } catch (e) { return '' } };
  const socialsIn = root => {
    const out = {};
    for (const a of root.querySelectorAll('a[href]')) {
      const h = abs(a.getAttribute('href'));
      if (/linkedin\.com\/in\//i.test(h)) out.linkedin = out.linkedin || h;
      else if (/instagram\.com\/[^/?#]+/i.test(h) && !/instagram\.com\/(p|reel|explore)\//i.test(h)) out.instagram = out.instagram || h;
      else if (/(twitter|x)\.com\/[^/?#]+/i.test(h) && !/\/(intent|share|status)\//i.test(h)) out.x = out.x || h;
    }
    return out;
  };
  const mailIn = root => {
    const a = root.querySelector('a[href^="mailto:" i]');
    if (a) return { v: decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]).trim(), how: 'mailto' };
    const m = txt(root).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return m ? { v: m[0], how: 'text' } : null;
  };
  const telIn = root => {
    const a = root.querySelector('a[href^="tel:" i]');
    return a ? { v: a.getAttribute('href').slice(4).trim(), how: 'tel' } : null;
  };

  // Company: what the site calls itself, in order of how deliberately it said so.
  let company = '', company_how = '';
  const og = document.querySelector('meta[property="og:site_name"]');
  if (og && og.content) { company = og.content.trim(); company_how = 'og:site_name'; }

  const people = [], seen = new Set();
  const add = (p) => {
    const key = (p.email && p.email.v || p.name.v).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); people.push(p);
  };

  // 1. schema.org Person in JSON-LD — the page telling us outright.
  const walk = (n, out) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, out)); return; }
    const t = [].concat(n['@type'] || []).map(String);
    if (t.includes('Organization') && n.name && !company) { company = String(n.name); company_how = 'json-ld'; }
    if (t.includes('Person') && n.name) out.push(n);
    for (const k of Object.keys(n)) if (typeof n[k] === 'object') walk(n[k], out);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    const found = [];
    try { walk(JSON.parse(s.textContent), found); } catch (e) { continue; }
    for (const n of found) {
      const name = String(n.name).trim();
      if (!isName(name)) continue;
      const sameAs = [].concat(n.sameAs || []).map(String);
      add({
        name: { v: name, how: 'json-ld' },
        title: n.jobTitle ? { v: String(n.jobTitle), how: 'json-ld' } : null,
        email: n.email ? { v: String(n.email).replace(/^mailto:/i, ''), how: 'json-ld' } : null,
        phone: n.telephone ? { v: String(n.telephone), how: 'json-ld' } : null,
        socials: Object.fromEntries(sameAs.map(u => [/linkedin/i.test(u) ? 'linkedin' : /instagram/i.test(u) ? 'instagram' : /(twitter|x)\.com/i.test(u) ? 'x' : 'web', u])),
        company: n.worksFor && n.worksFor.name ? String(n.worksFor.name) : null,
      });
    }
  }

  // 2. People on the page, found NAME-FIRST and kept only with EVIDENCE.
  //    The first version found cards by class name and accepted any Two Capitalised Words in
  //    them. On ycombinator.com/people that returned three "people" — "Application Operations",
  //    "Investment Operations", "Post Batch" (section headings) — and missed all ~100 real ones,
  //    whose cards are an <a> with no class: photo, name, title, bio. Name-shaped text is
  //    everywhere (nav: "Startup Directory", "Hacker News"), so shape alone proves nothing.
  //    Now: skip page chrome; grow each name's card outward only while it holds exactly ONE
  //    name (a heading over a grid of people never becomes a card); and keep the name only if
  //    the card carries at least one signal a person has — a photo, a short title line, or a
  //    personal contact. The signals are returned, so every lead says why it was believed.
  const inChrome = el => !!el.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo],' +
    '[class*=dropdown],[class*=menu],[class*=navbar],[class*=breadcrumb],[class*=cookie],[class*=footer],[class*=header]');
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const nameLeaves = [];
  for (const el of document.querySelectorAll('body *')) {
    if (nameLeaves.length >= 600) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|OPTION|TITLE)$/.test(el.tagName) || inChrome(el)) continue;
    const t = ownText(el) || (el.children.length === 0 ? txt(el) : '');
    if (t && isName(t)) nameLeaves.push({ el, name: cleanName(t) });
  }
  const namesIn = a => nameLeaves.reduce((n, x) => n + (a.contains(x.el) ? 1 : 0), 0);
  const ROLE = /(ceo|cto|cfo|coo|founder|partner|director|manager|president|vice|head|lead|chief|officer|owner|principal|associate|engineer|designer|dentist|doctor|physician|attorney|lawyer|counsel|agent|broker|advisor|consultant|analyst|specialist|coordinator|assistant|professor|teacher|nurse|therapist|surgeon|orthodontist|hygienist|chair|member|editor|writer|producer|artist|coach|recruiter|representative|sales|marketing|operations|executive|investor|fellow|scientist|researcher|accountant|controller|counsel|paralegal|legal|product|technical|staff|editor|curator|producer)/i;
  for (const { el, name } of nameLeaves) {
    let card = el;
    for (let a = el.parentElement, d = 0; a && a !== document.body && d < 6; a = a.parentElement, d++) {
      if (namesIn(a) > 1) break;
      card = a;
    }
    const lines = (card.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
    const i = lines.findIndex(x => cleanName(x) === name);
    const nxt = i >= 0 ? lines[i + 1] : null;
    let title = null;
    const tEl = card.querySelector('[itemprop=jobTitle],.title,.position,.role,.job,[class*=title],[class*=position],[class*=role]');
    if (tEl && txt(tEl) && cleanName(txt(tEl)) !== name && txt(tEl).length <= 90) title = { v: txt(tEl), how: 'card:class' };
    else if (nxt && nxt.length <= 90 && !/@|https?:/.test(nxt) && !isName(nxt)) title = { v: nxt, how: 'card:next-line' };
    const img = [...card.querySelectorAll('img')].find(im => {
      const r = im.getBoundingClientRect(); return r.width >= 32 && r.height >= 32;
    });
    const email = mailIn(card), phone = telIn(card), socials = socialsIn(card);
    const evidence = [];
    if (img) evidence.push('photo');
    if (title && ROLE.test(title.v)) evidence.push('role-title');
    else if (title && title.how === 'card:class') evidence.push('title');
    if (email) evidence.push('email');
    if (phone) evidence.push('phone');
    if (Object.keys(socials).length) evidence.push('social');
    if (!evidence.length) continue;                 // shaped like a name, nothing says it is a person
    add({ name: { v: name, how: 'card' }, title, email, phone, socials, company: null, evidence });
  }

  // 3. Loose contacts — a mailto/tel that belongs to no card. Kept separately: an address with
  //    no person attached is a lead for a COMPANY, and must not be presented as a person.
  // Seed with EVERY value already attached to a person — emails and phones. Seeding with emails
  // only listed a person's own phone a second time as an anonymous company contact.
  const contacts = [], cseen = new Set(people.flatMap(p => [p.email && p.email.v, p.phone && p.phone.v]).filter(Boolean));
  for (const a of document.querySelectorAll('a[href^="mailto:" i], a[href^="tel:" i]')) {
    const h = a.getAttribute('href');
    const isMail = /^mailto:/i.test(h);
    const v = isMail ? decodeURIComponent(h.slice(7).split('?')[0]).trim() : h.slice(4).trim();
    if (!v || cseen.has(v)) continue;
    cseen.add(v);
    let ctx = '';
    for (let n = a; n && !ctx; n = n.parentElement) {
      const hd = n.querySelector && n.querySelector('h1,h2,h3,h4,h5,h6');
      if (hd) ctx = txt(hd).slice(0, 60);
    }
    contacts.push({ kind: isMail ? 'email' : 'phone', value: v, label: txt(a).slice(0, 60), context: ctx });
  }

  if (!company) {
    const parts = document.title.split(/\s[|\-–—·]\s/);
    company = (parts.length > 1 ? parts[parts.length - 1] : location.hostname.replace(/^www\./, '')).trim();
    company_how = parts.length > 1 ? 'title' : 'hostname';
  }

  const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: txt(a).slice(0, 60), href: abs(a.getAttribute('href')) }))
    .filter(l => l.href.startsWith(location.origin));
  const nav = performance.getEntriesByType('navigation')[0] || {};
  return { url: location.href, status: nav.responseStatus || null, title: document.title,
           company, company_how, people, contacts, links };
})()
"""

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
