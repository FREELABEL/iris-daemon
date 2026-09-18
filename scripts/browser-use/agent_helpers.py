"""IRIS helpers for browser-use (browser-harness) — loaded into every script automatically.

browser-harness imports <agent-workspace>/agent_helpers.py and copies every public name into the
script's globals, so `safe_click(...)` is available next to `new_tab`, `js`, `cdp`. Install:

    ln -sf ~/.iris/bridge/scripts/browser-use/agent_helpers.py \
           ~/.config/browser-harness/agent-workspace/agent_helpers.py

WHY THIS EXISTS. Two clicks this week reported success and did nothing:
  - `click_at_xy` on the centre of a link's bounding box landed on plain text, because the link
    wrapped across two lines and the box's centre was between them. No error.
  - `agent-browser click @e2` on the same link printed "✓ Done" and did not navigate.
Neither tool checked what was actually UNDER the point before clicking, or whether anything
happened after. The technique here is adapted from browser-use/jev-ultrafast (MIT): snapshot the
controls once, keep references to the real nodes, and before every click re-resolve the node's
CURRENT geometry and refuse if something else is on top of it.

    els = elements()                 # indexed table of visible controls
    r = safe_click(3)                # by index from the table
    r = click_text("Get Started")    # by visible text / accessible name
    r["changed"]                     # did the URL or DOM actually change?

safe_click RAISES ClickBlocked rather than clicking something else — a click that lands on the
wrong element is worse than one that does not happen.
"""

import time as _time

# browser-harness execs this file as its OWN module and then copies our public names into the
# script's globals — so the harness's js()/page_info()/click_at_xy() are NOT in scope here. Reach
# them through the harness module at CALL time: it is still initialising when it imports us.
import browser_harness.helpers as _h  # noqa: E402


# Private on purpose: the loader copies every PUBLIC name back into browser_harness.helpers, so a
# public `js` here would replace the harness's own js() with this wrapper, which calls _h.js —
# itself — forever.
def _js(expr):
    return _h.js(expr)


def _page_info():
    return _h.page_info()

_SNAPSHOT_JS = r"""
(() => {
  const gen = (window.__irisGen = (window.__irisGen || 0) + 1);
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
              '[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],' +
              '[onclick],[tabindex]:not([tabindex="-1"])';
  const vw = innerWidth, vh = innerHeight;
  const out = [], nodes = [];
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const rects = el.getClientRects();
    if (!rects.length) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.title ||
                  el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
    nodes.push(el);
    out.push({
      i: nodes.length,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      name: name.slice(0, 80),
      href: el.getAttribute('href') || '',
      value: 'value' in el ? String(el.value).slice(0, 60) : '',
      in_view: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
      lines: rects.length,
    });
  }
  window.__irisEls = nodes;
  return { gen, count: out.length, elements: out };
})()
"""

# Re-resolve CURRENT geometry for node i and ask the page what is actually on top of it. The point
# is the centre of the FIRST line box (getClientRects()[0]), not the bounding box — a link that
# wraps has a bounding box whose centre lies between its lines, on plain text.
_PROBE_JS = r"""
((i, gen) => {
  const nodes = window.__irisEls || [];
  if (window.__irisGen !== gen) return { error: 'stale', detail: 'page changed since elements() — call elements() again' };
  const el = nodes[i - 1];
  if (!el) return { error: 'no_such_element', detail: `no element ${i}; the table has ${nodes.length}` };
  if (!el.isConnected) return { error: 'detached', detail: 'element was removed from the page' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rects = [...el.getClientRects()].filter(r => r.width > 0 && r.height > 0);
  if (!rects.length) return { error: 'no_box', detail: 'element has no visible box' };
  const r = rects[0];
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight)
    return { error: 'offscreen', detail: `point (${Math.round(x)},${Math.round(y)}) is outside the viewport` };
  const hit = document.elementFromPoint(x, y);
  const ok = hit && (hit === el || el.contains(hit) || hit.contains(el) && hit.children.length === 0);
  const desc = n => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
    (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : 'nothing';
  return { x, y, ok: !!ok, target: desc(el), hit: desc(hit),
           hit_text: hit ? (hit.innerText || '').trim().slice(0, 40) : '' };
})
"""


class ClickBlocked(RuntimeError):
    """The element could not be clicked safely — raised instead of clicking the wrong thing."""


_state = {"gen": None}


def elements(in_view_only=False):
    """Snapshot visible interactive controls into an indexed table. Returns the list of dicts."""
    snap = _js(_SNAPSHOT_JS)
    _state["gen"] = snap["gen"]
    els = snap["elements"]
    return [e for e in els if e["in_view"]] if in_view_only else els


def _fingerprint():
    return _js("(() => location.href + '|' + document.title + '|' + document.body.innerText.length)()")


def safe_click(index, wait=1.0):
    """Click element `index` from the last elements() table, only if it is really under the point.

    Returns {clicked, target, x, y, url_before, url_after, changed}. `changed` is True when the URL,
    title or body length moved — the outcome check both tools we measured skipped.
    """
    if _state["gen"] is None:
        raise ClickBlocked("call elements() first — safe_click needs the table it indexes into")
    probe = _js(f"{_PROBE_JS}({int(index)}, {int(_state['gen'])})")
    if probe.get("error"):
        raise ClickBlocked(f"{probe['error']}: {probe['detail']}")
    if not probe["ok"]:
        raise ClickBlocked(
            f"{probe['target']} is covered by {probe['hit']}"
            + (f' ("{probe["hit_text"]}")' if probe.get("hit_text") else "")
            + " — refusing to click the element on top"
        )
    before = _fingerprint()
    url_before = _page_info()["url"]
    _h.click_at_xy(probe["x"], probe["y"])
    _time.sleep(wait)
    try:
        _h.wait_for_load(timeout=10)
    except Exception:
        pass  # a click that does not navigate has no load to wait for
    after = _fingerprint()
    return {
        "clicked": True,
        "target": probe["target"],
        "x": round(probe["x"]),
        "y": round(probe["y"]),
        "url_before": url_before,
        "url_after": _page_info()["url"],
        "changed": after != before,
    }


def click_text(text, exact=False, wait=1.0):
    """Find a control by its visible text / accessible name and safe_click it.

    Refuses when the text matches more than one visible control — guessing between two
    "Next" buttons is how a scraper pages the wrong list.
    """
    needle = text.strip().lower()
    els = elements()
    hits = [e for e in els if (e["name"].lower() == needle if exact else needle in e["name"].lower())]
    if not hits:
        raise ClickBlocked(f'no visible control matching "{text}" (searched {len(els)})')
    if len(hits) > 1:
        shown = ", ".join(f'[{e["i"]}] {e["name"][:30]!r}' for e in hits[:5])
        raise ClickBlocked(f'"{text}" matches {len(hits)} controls: {shown} — use safe_click(index)')
    return safe_click(hits[0]["i"], wait=wait)


def print_elements(limit=60):
    """Print the table the way a person (or model) reads it: [i] tag  name  → href."""
    for e in elements()[:limit]:
        tail = f'  → {e["href"][:60]}' if e["href"] else ""
        view = "" if e["in_view"] else "  (offscreen)"
        print(f'[{e["i"]}] {e["tag"]:<8} {e["name"][:50]}{tail}{view}')
