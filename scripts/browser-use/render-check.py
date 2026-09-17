# Render check, executed by browser-use (helpers pre-imported: new_tab, cdp, js, ...).
# Parameters arrive as env vars so nothing in the page or the caller is ever spliced into code.
#   RC_URL        page to check (required)
#   RC_OUT        directory for screenshots (required)
#   RC_VIEWPORTS  "desktop:1280x900,mobile:390x844"
#   RC_SCHEMES    "light,dark" — emulated prefers-color-scheme (artifacts follow the OS;
#                 Genesis pages follow html.dark, so identical shots there are expected)
# Prints exactly one JSON line prefixed RC_RESULT=.
import json, os, time

url = os.environ["RC_URL"]
out = os.environ["RC_OUT"]
viewports = [
    (name, *map(int, size.split("x")))
    for name, size in (v.split(":") for v in os.environ.get("RC_VIEWPORTS", "desktop:1280x900,mobile:390x844").split(","))
]
schemes = [s for s in os.environ.get("RC_SCHEMES", "light").split(",") if s]

result = {"url": url, "viewports": {}, "screenshots": [], "console_errors": [], "failures": []}

new_tab("about:blank")
# Errors are collected IN the page, installed before any page script runs. The daemon's event
# buffer holds 500 events and wait_for_network_idle consumes it, so on a real page a thrown
# error is gone by the time we read — the first version of this check reported [] for a page
# that threw on load.
cdp("Page.addScriptToEvaluateOnNewDocument", source="""
  window.__rcErrors = [];
  const push = m => { try { window.__rcErrors.push(String(m).slice(0, 300)); } catch (_) {} };
  addEventListener('error', e => push(e.error && e.error.stack || e.message), true);
  addEventListener('unhandledrejection', e => push('unhandled rejection: ' + (e.reason && e.reason.stack || e.reason)));
  const orig = console.error.bind(console);
  console.error = (...a) => { push(a.map(x => x && x.stack || x).join(' ')); orig(...a); };
""")
goto_url(url)
wait_for_load(timeout=30)
try:
    wait_for_network_idle(timeout=10)
except Exception:
    pass  # long-polling pages never go idle; the load event already fired

page = js("""(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const text = (document.body && document.body.innerText || '').slice(0, 4000);
  // A family "resolves" if text set in it measures differently from BOTH generic fallbacks.
  // Comparing computed font-family strings cannot tell: the string survives a silent fallback.
  const c = document.createElement('canvas').getContext('2d');
  const probe = 'mmmmmmmmmwwwwwwwiiiiiii0123456789';
  const w = f => { c.font = '72px ' + f; return c.measureText(probe).width; };
  const fams = {};
  for (const el of document.querySelectorAll('h1,h2,h3,p,li,code,td,button')) {
    const first = getComputedStyle(el).fontFamily.split(',')[0].trim();
    if (!first || fams[first] !== undefined) continue;
    const bare = first.replace(/^["']|["']$/g, '');
    const generic = ['serif','sans-serif','monospace','system-ui','cursive','fantasy','ui-monospace','ui-sans-serif','ui-serif','-apple-system'];
    fams[bare] = generic.includes(bare) ? true
      : !(w('"' + bare + '", monospace') === w('monospace') && w('"' + bare + '", serif') === w('serif'));
  }
  return {
    href: location.href,
    status: nav.responseStatus || null,
    title: document.title,
    h1: [...document.querySelectorAll('h1')].map(h => h.innerText.trim().slice(0, 120)),
    looks_like_not_found: /\\b(404|page not found|not found)\\b/i.test(document.title + ' ' + text.slice(0, 400)),
    fonts: fams,
    html_class: document.documentElement.className,
  };
})()""")
result.update(page)

# A page that never loaded is not a page that passed. Chrome shows its own error document
# (chrome-error://) with no navigation status; say so and stop, rather than measure the error page.
if page["href"].startswith("chrome-error://") or page["status"] is None:
    result.update(ok=False, measured=False, error="page did not load (unreachable, DNS, TLS or refused)")
    print("RC_RESULT=" + json.dumps(result))
    raise SystemExit(0)
result["measured"] = True

if page["status"] and page["status"] >= 400:
    result["failures"].append(f"HTTP {page['status']}")
if page["looks_like_not_found"]:
    result["failures"].append("page reads as a not-found page")
if not page["h1"]:
    result["failures"].append("no h1")
for fam, ok in page["fonts"].items():
    if not ok:
        result["failures"].append(f"font '{fam}' does not resolve — silently falling back")

slug = "".join(ch if ch.isalnum() else "-" for ch in url.split("://", 1)[-1])[:60].strip("-")
for name, width, height in viewports:
    cdp("Emulation.setDeviceMetricsOverride", width=width, height=height,
        deviceScaleFactor=1 if name == "desktop" else 2, mobile=name != "desktop")
    time.sleep(0.8)
    over = js("""(() => {
      const vw = document.documentElement.clientWidth;
      const overflow = document.documentElement.scrollWidth > vw + 1;
      const offenders = !overflow ? [] : [...document.querySelectorAll('body *')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; })
        .slice(0, 5)
        .map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : ''));
      return { scroll_width: document.documentElement.scrollWidth, viewport_width: vw,
               overflow_x: overflow, offenders };
    })()""")
    result["viewports"][name] = over
    if name != "desktop" and over["viewport_width"] > width + 1:
        # No <meta name=viewport>: phones lay the page out at ~980px and shrink it, so nothing
        # "overflows" and the text is unreadable. The overflow test alone passes this page.
        result["failures"].append(f"{name} ({width}px): no responsive viewport meta — lays out at {over['viewport_width']}px")
    if over["overflow_x"]:
        result["failures"].append(f"{name} ({width}px): horizontal overflow, scrollWidth {over['scroll_width']}")
    for scheme in schemes:
        cdp("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": scheme}])
        time.sleep(0.4)
        path = os.path.join(out, f"{slug}-{name}-{scheme}.png")
        capture_screenshot(path, max_dim=1800)
        result["screenshots"].append(path)

result["console_errors"] = js("window.__rcErrors || []")[:20]

result["ok"] = not result["failures"]
print("RC_RESULT=" + json.dumps(result))
