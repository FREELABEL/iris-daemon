/**
 * Action Executor — maps LLM action decisions to Playwright calls.
 *
 * Supported actions:
 *   click, type, press, scroll, navigate, extract, screenshot, wait, done, fail
 */

const fs = require('fs')
const path = require('path')
const { getLocatorForElement } = require('./dom-extractor')

/**
 * Execute a single action on the page.
 * @param {import('playwright').Page} page
 * @param {object} action - { type, element?, text?, direction?, url?, selector?, save_as?, key?, result?, reason? }
 * @param {object} dom - DOM snapshot from extractDOM()
 * @param {string} outputDir - path to .output/ for saving files
 * @returns {{ ok: boolean, message: string, done?: boolean, result?: string, error?: string }}
 */
async function executeAction(page, action, dom, outputDir) {
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
      // Security: check domain allowlist
      const allowed = process.env.ALLOWED_DOMAINS
      if (allowed) {
        const allowedList = allowed.split(',').map(d => d.trim().replace('*.', ''))
        const urlHost = new URL(action.url).hostname
        const domainAllowed = allowedList.some(d => urlHost === d || urlHost.endsWith('.' + d))
        if (!domainAllowed) {
          return { ok: false, message: `Domain ${urlHost} not in allowed list: ${allowed}` }
        }
      }
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
      if (action.save_as && outputDir) {
        const filePath = path.join(outputDir, action.save_as)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
      }

      // Truncate for log output
      const preview = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)
      return { ok: true, message: `Extracted ${data.length} chars`, data: preview }
    }

    case 'screenshot': {
      const filename = action.save_as || `step-screenshot.png`
      const filePath = outputDir ? path.join(outputDir, filename) : filename
      if (outputDir) fs.mkdirSync(path.dirname(filePath), { recursive: true })
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
