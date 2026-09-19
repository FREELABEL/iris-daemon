/**
 * Action Executor — maps LLM action decisions to Playwright calls.
 *
 * Supported actions:
 *   click, type, press, scroll, navigate, extract, screenshot, wait, done, fail
 */

const fs = require('fs')
const path = require('path')
const { getLocatorForElement } = require('./dom-extractor')
const { navigationAllowed, safeOutputPath } = require('./untrusted')

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
    case 'click': {
      const handle = await getLocatorForElement(page, dom, action.element)
      if (!handle) return { ok: false, message: `Element ${action.element} not found` }
      await handle.scrollIntoViewIfNeeded().catch(() => {})
      await handle.click({ timeout: 5000 })
      return { ok: true, message: `Clicked ${action.element}` }
    }

    case 'type': {
      if (!action.text) return { ok: false, message: 'No text provided for type action' }
      if (action.element) {
        const handle = await getLocatorForElement(page, dom, action.element)
        if (!handle) return { ok: false, message: `Element ${action.element} not found` }
        await handle.scrollIntoViewIfNeeded().catch(() => {})
        // Clear existing value first, then fill
        await handle.evaluate(el => { if (el.value !== undefined) el.value = '' })
        await handle.type(action.text, { delay: 30 })
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

      // Truncate for log output
      const preview = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)
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

module.exports = { executeAction }
