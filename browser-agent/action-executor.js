/**
 * Action Executor — maps LLM action decisions to Playwright calls.
 *
 * Supported actions:
 *   tool, click, type, form_input, press, scroll, navigate, find, extract, screenshot, zoom, wait,
 *   done, fail
 *
 * An action on an element that is gone returns a TYPED result, not an exception string:
 *   { ok: false, error: 'stale_ref', ref: '@N', hint: 'call find to locate it again', message }
 * so the next step can recover by looking again instead of retrying a ref that cannot work (#188588).
 */

const fs = require('fs')
const path = require('path')
const { resolveElement } = require('./dom-extractor')
const { navigationAllowed, safeOutputPath } = require('./untrusted')
const { findInText } = require('./find-in-text')

const STALE_HINT = 'call find to locate it again'

function refError(error, ref) {
  if (error === 'stale_ref') {
    return { ok: false, error, ref, hint: STALE_HINT, message: `Element ${ref} no longer exists on the page (stale_ref) — the page changed since it was listed; ${STALE_HINT}, or use the current element list` }
  }
  return { ok: false, error, ref, hint: 'use an @N from the current element list', message: `Element ${ref} is not in the current element list (unknown_ref)` }
}

/** Playwright's ways of saying "that element left the document". */
const DETACHED = /not attached to the DOM|Element is detached|Execution context was destroyed|Target closed|has been removed/i

/** Resolve action.element, or the typed error for why it cannot be. */
async function target(page, dom, ref) {
  const r = await resolveElement(page, dom, ref)
  return r.handle ? { handle: r.handle } : { fail: refError(r.error, r.ref) }
}

/** Run an element action; an element that detaches mid-action is stale, not a crash. */
async function onElement(ref, fn) {
  try {
    return await fn()
  } catch (e) {
    if (DETACHED.test(e.message || '')) return refError('stale_ref', ref)
    throw e
  }
}

/** "false", "off", "no", "0", "unchecked" → false; anything else truthy → true. */
function wantChecked(v) {
  if (typeof v === 'boolean') return v
  if (v === undefined || v === null) return true
  return !/^(false|off|no|0|unchecked|uncheck)$/i.test(String(v).trim())
}

/**
 * Set a field to a value directly — fill / selectOption / setChecked by what the element is — rather
 * than typing keystrokes into it. One action per field, and what landed is read back.
 */
async function formInput(handle, ref, value) {
  const kind = await handle.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
    role: (el.getAttribute('role') || '').toLowerCase(),
    editable: el.isContentEditable,
  }))
  await handle.scrollIntoViewIfNeeded().catch(() => {})

  if (kind.tag === 'select') {
    const values = (Array.isArray(value) ? value : [value]).map(String)
    // By value first, then by visible label — the model sees labels more often than values.
    let picked = await handle.selectOption(values, { timeout: 5000 }).catch(() => [])
    if (!picked.length) picked = await handle.selectOption(values.map((label) => ({ label })), { timeout: 5000 }).catch(() => [])
    if (!picked.length) {
      const options = await handle.evaluate((el) => [...el.options].map((o) => o.label || o.value).slice(0, 20))
      return { ok: false, message: `No option "${values.join(', ')}" in ${ref}. Options: ${options.join(' | ')}` }
    }
    return { ok: true, message: `Set ${ref} (select) to ${picked.join(', ')}` }
  }

  if (kind.type === 'checkbox' || kind.type === 'radio' || kind.role === 'checkbox' || kind.role === 'radio' || kind.role === 'switch') {
    const checked = wantChecked(value)
    if (kind.type === 'radio' && !checked) return { ok: false, message: `${ref} is a radio button — it cannot be unchecked directly; set another option in its group instead` }
    await handle.setChecked(checked, { timeout: 5000 })
    return { ok: true, message: `Set ${ref} (${kind.type || kind.role}) to ${checked ? 'checked' : 'unchecked'}` }
  }

  if (kind.tag === 'input' || kind.tag === 'textarea' || kind.editable) {
    const text = value === undefined || value === null ? '' : String(value)
    await handle.fill(text, { timeout: 5000 })
    const landed = await handle.evaluate((el) => (el.isContentEditable ? el.innerText : el.value))
    return { ok: true, message: `Set ${ref} to "${String(landed).slice(0, 40)}"` }
  }

  return { ok: false, message: `${ref} is a <${kind.tag}>, not a form field — use click` }
}

/**
 * Re-read one region at full resolution. x,y,w,h are in the space of the `screenshot` action: the
 * viewport by default, the whole document with full_page. The image goes back to the model on the
 * next step; it is a crop, so coordinates the model gives afterwards stay in the page's space.
 */
const MAX_ZOOM_SIDE = 2000

async function zoom(page, action, outputDir) {
  const region = action.region || action.clip || action
  const x = Number(region.x), y = Number(region.y)
  const w = Number(region.w ?? region.width), h = Number(region.h ?? region.height)
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return { ok: false, message: 'zoom needs a region: {"type":"zoom","x":0,"y":0,"w":400,"h":300} (pixels, screenshot space)' }
  }
  const fullPage = !!action.full_page
  const bounds = fullPage
    ? await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))
    : page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const cx = Math.max(0, Math.floor(x)), cy = Math.max(0, Math.floor(y))
  const clip = {
    x: cx,
    y: cy,
    width: Math.min(Math.ceil(w), MAX_ZOOM_SIDE, bounds.width - cx),
    height: Math.min(Math.ceil(h), MAX_ZOOM_SIDE, bounds.height - cy),
  }
  if (clip.width <= 0 || clip.height <= 0) {
    return { ok: false, message: `zoom region is outside the ${fullPage ? 'page' : 'viewport'} (${bounds.width}x${bounds.height})` }
  }
  const buffer = await page.screenshot({ clip, fullPage, type: 'png' })
  let saved = ''
  if (action.save_as) {
    const filePath = safeOutputPath(outputDir, action.save_as)
    if (!filePath) return { ok: false, message: `Refused to save zoom "${action.save_as}": files may only be written inside the task output folder` }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buffer)
    saved = `, saved ${action.save_as}`
  }
  return {
    ok: true,
    message: `Zoomed on ${clip.width}x${clip.height} at (${clip.x},${clip.y})${saved} — the image is attached to the next step; coordinates stay in the full ${fullPage ? 'page' : 'viewport'} space`,
    clip,
    image: { mime: 'image/png', base64: buffer.toString('base64') },
  }
}

/**
 * Execute a single action on the page.
 * @param {import('playwright').Page} page
 * @param {object} action - { type, element?, text?, direction?, url?, selector?, save_as?, key?, result?, reason? }
 * @param {object} dom - DOM snapshot from extractDOM()
 * @param {string} outputDir - path to .output/ for saving files
 * @returns {{ ok: boolean, message: string, done?: boolean, result?: string, error?: string }}
 */
async function executeAction(page, action, dom, outputDir, opts = {}) {
  const type = action.type?.toLowerCase()

  switch (type) {
    // A tool the page declared (WebMCP) — see page-tools.js. Approval for consequential tools is
    // the operator's (task config), enforced there, not left to the model.
    case 'tool': {
      if (!opts.pageTools) return { ok: false, message: 'Page tools are not available in this run — use click/type' }
      if (!action.name) return { ok: false, message: 'No tool name provided for tool action' }
      return opts.pageTools.call(action.name, action.input ?? action.args ?? {}, { approve: opts.approveTools })
    }

    case 'click': {
      const t = await target(page, dom, action.element)
      if (t.fail) return t.fail
      return onElement(action.element, async () => {
        await t.handle.scrollIntoViewIfNeeded().catch(() => {})
        await t.handle.click({ timeout: 5000 })
        return { ok: true, message: `Clicked ${action.element}` }
      })
    }

    case 'form_input': {
      if (!action.element) return { ok: false, message: 'form_input needs an "element" (@N) and a "value"' }
      const t = await target(page, dom, action.element)
      if (t.fail) return t.fail
      const value = action.value !== undefined ? action.value : action.text
      return onElement(action.element, () => formInput(t.handle, action.element, value))
    }

    case 'type': {
      if (!action.text) return { ok: false, message: 'No text provided for type action' }
      if (action.element) {
        const t = await target(page, dom, action.element)
        if (t.fail) return t.fail
        const r = await onElement(action.element, async () => {
          await t.handle.scrollIntoViewIfNeeded().catch(() => {})
          // Clear existing value first, then fill
          await t.handle.evaluate(el => { if (el.value !== undefined) el.value = '' })
          await t.handle.type(action.text, { delay: 30 })
        })
        if (r && r.ok === false) return r
      } else {
        // Type into currently focused element
        await page.keyboard.type(action.text, { delay: 30 })
      }
      return { ok: true, message: `Typed "${action.text.slice(0, 40)}"` }
    }

    case 'press': {
      const key = action.key || action.text || 'Enter'
      await page.keyboard.press(key)
      return { ok: true, message: `Pressed ${key}` }
    }

    case 'scroll': {
      const direction = action.direction || 'down'
      const amount = action.amount || 400
      if (direction === 'down') {
        await page.mouse.wheel(0, amount)
      } else if (direction === 'up') {
        await page.mouse.wheel(0, -amount)
      }
      return { ok: true, message: `Scrolled ${direction} ${amount}px` }
    }

    case 'navigate': {
      if (!action.url) return { ok: false, message: 'No URL provided for navigate action' }
      // Security (#185962): http(s) only, and stay on the task's own site unless the operator widened
      // it — ALLOWED_DOMAINS still wins when set. A page cannot talk the agent into leaving.
      const verdict = navigationAllowed(action.url, opts.nav || {})
      if (!verdict.ok) return { ok: false, message: verdict.reason }
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      return { ok: true, message: `Navigated to ${action.url}` }
    }

    // SEARCH the page rather than read it from the top. Every long-page failure measured on
    // 2026-09-20 was a window problem: the agent could not ask WHERE something was (#186360).
    case 'find': {
      const page_text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
      let found
      try {
        found = findInText(page_text, action.text ?? action.query ?? action.selector)
      } catch (e) {
        return { ok: false, message: e.message }
      }
      return { ok: true, message: `find "${action.text ?? action.query ?? ''}" — ${found.matches} match(es)`, data: found.text }
    }

    case 'extract': {
      let data
      if (action.selector) {
        data = await page.$eval(action.selector, el => el.innerText || el.textContent).catch(() => null)
      } else {
        // Extract full page text
        data = await page.evaluate(() => document.body.innerText).catch(() => '')
      }
      if (!data) return { ok: false, message: 'No data extracted' }

      // Optionally save to file
      if (action.save_as) {
        // Only inside the task's output folder (#185962) — save_as came from the model, which reads the page.
        const filePath = safeOutputPath(outputDir, action.save_as)
        if (!filePath) return { ok: false, message: `Refused to save to "${action.save_as}": files may only be written inside the task output folder` }
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
      }

      // The text goes BACK TO THE MODEL (history-entry.js bounds it), so 200 chars is too little
      // to answer a question with — that cap is why an extract taught the agent nothing (#186360).
      const cap = Number(process.env.BROWSER_AGENT_EXTRACT_CHARS) || 4000
      const preview = typeof data === 'string' ? data.slice(0, cap) : JSON.stringify(data).slice(0, cap)
      return { ok: true, message: `Extracted ${data.length} chars`, data: preview }
    }

    case 'screenshot': {
      const filename = action.save_as || `step-screenshot.png`
      // Only inside the task's output folder (#185962). With no folder it used to write into the cwd.
      const filePath = safeOutputPath(outputDir, filename)
      if (!filePath) return { ok: false, message: `Refused to save screenshot "${filename}": no task output folder, or the name leaves it` }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      await page.screenshot({ path: filePath, fullPage: action.full_page || false })
      return { ok: true, message: `Screenshot saved: ${filename}` }
    }

    case 'zoom':
      return zoom(page, action, outputDir)

    case 'wait': {
      const ms = Math.min((action.seconds || 2) * 1000, 10000)
      await page.waitForTimeout(ms)
      return { ok: true, message: `Waited ${ms}ms` }
    }

    case 'done': {
      return { ok: true, done: true, result: action.result || 'Task completed', message: 'Done' }
    }

    case 'fail': {
      return { ok: false, done: true, error: action.reason || 'Task failed', message: action.reason || 'Failed' }
    }

    default:
      return { ok: false, message: `Unknown action type: ${type}` }
  }
}

module.exports = { executeAction, wantChecked, STALE_HINT }
