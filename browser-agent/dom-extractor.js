/**
 * DOM Extractor — extracts interactive elements from a Playwright page
 * into a structured format an LLM can reason about.
 *
 * Returns: { url, title, elements: [{id, tag, role, text, type, href, placeholder, checked, value}] }
 */

const MAX_ELEMENTS = 50
const MAX_TEXT_LENGTH = 80

/**
 * Extract interactive elements from the current page.
 * Uses querySelectorAll for reliability over accessibility tree (which can be incomplete).
 */
async function extractDOM(page) {
  const url = page.url()
  const title = await page.title()

  const elements = await page.evaluate(({ maxElements, maxText }) => {
    const selectors = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="searchbox"]',
      '[onclick]',
      '[contenteditable="true"]',
    ]

    const seen = new Set()
    const results = []

    for (const selector of selectors) {
      if (results.length >= maxElements) break
      try {
        const nodes = document.querySelectorAll(selector)
        for (const el of nodes) {
          if (results.length >= maxElements) break
          if (seen.has(el)) continue
          seen.add(el)

          // Skip hidden elements
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue

          // Skip elements outside viewport (with generous margin)
          const vh = window.innerHeight
          const vw = window.innerWidth
          if (rect.bottom < -100 || rect.top > vh + 100 || rect.right < -100 || rect.left > vw + 100) continue

          const tag = el.tagName.toLowerCase()
          const role = el.getAttribute('role') || ''
          const type = el.getAttribute('type') || ''
          const href = el.getAttribute('href') || ''
          const placeholder = el.getAttribute('placeholder') || ''
          const ariaLabel = el.getAttribute('aria-label') || ''

          // Get visible text
          let text = ariaLabel || el.innerText || el.textContent || ''
          text = text.replace(/\s+/g, ' ').trim()
          if (text.length > maxText) text = text.slice(0, maxText) + '…'

          // Value for inputs
          const value = (tag === 'input' || tag === 'textarea' || tag === 'select') ? (el.value || '') : ''

          // Checked state
          const checked = el.checked === true ? true : undefined

          results.push({
            tag,
            role,
            text,
            type,
            href: href && href !== '#' ? href : '',
            placeholder,
            value: value ? value.slice(0, 50) : '',
            checked,
            // Store a selector path for targeting
            _index: results.length,
          })
        }
      } catch (e) {
        // Skip invalid selectors
      }
    }

    return results
  }, { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT_LENGTH })

  // Assign @IDs
  const indexed = elements.map((el, i) => ({
    id: `@${i + 1}`,
    ...el,
    _index: i,
  }))

  // THE PAGE ITSELF. Without this the snapshot is a list of things to click, and a page of prose
  // arrives as "(no interactive elements found)" — the agent cannot answer a question about
  // content it was never shown (#186360). Bounded: this goes into every prompt.
  const text = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim())
    .catch(() => '')

  return { url, title, elements: indexed, text }
}

/**
 * Format DOM snapshot as a string for LLM consumption.
 */
const DEFAULT_TEXT_CHARS = Number(process.env.BROWSER_AGENT_TEXT_CHARS) || 3000

function formatDOM(dom, opts = {}) {
  const limit = opts.textChars ?? DEFAULT_TEXT_CHARS
  const lines = []
  lines.push(`URL: ${dom.url}`)
  lines.push(`Title: ${dom.title}`)
  if (dom.text) {
    const shown = String(dom.text).slice(0, limit)
    lines.push('')
    lines.push(`Page text (first ${shown.length} characters${String(dom.text).length > limit ? ', truncated' : ''}):`)
    lines.push(shown)
  }
  lines.push('')
  lines.push('Interactive elements:')

  for (const el of dom.elements) {
    let desc = `${el.id} [${el.tag}`
    if (el.type) desc += ` type="${el.type}"`
    if (el.role && el.role !== el.tag) desc += ` role="${el.role}"`
    desc += ']'
    if (el.text) desc += ` "${el.text}"`
    if (el.placeholder) desc += ` placeholder="${el.placeholder}"`
    if (el.href) desc += ` href="${el.href.slice(0, 80)}"`
    if (el.value) desc += ` value="${el.value}"`
    if (el.checked !== undefined) desc += ` checked=${el.checked}`
    lines.push(desc)
  }

  if (dom.elements.length === 0) {
    lines.push('(no interactive elements found)')
  }

  return lines.join('\n')
}

/**
 * Get a Playwright locator for an element by its @ID.
 * Uses nth-match against the same selector set used during extraction.
 */
async function getLocatorForElement(page, dom, elementId) {
  const id = elementId.replace('@', '')
  const idx = parseInt(id, 10) - 1
  const el = dom.elements[idx]
  if (!el) return null

  // Use page.locator with the element's original index from the full extraction
  // We re-query using the same selectors and pick the nth match
  const allSelectors = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="combobox"]',
    '[role="searchbox"]', '[onclick]', '[contenteditable="true"]',
  ]

  // Find the element by re-evaluating and matching index
  const handle = await page.evaluateHandle(({ selectors, targetIndex }) => {
    const seen = new Set()
    let count = 0
    for (const selector of selectors) {
      try {
        const nodes = document.querySelectorAll(selector)
        for (const el of nodes) {
          if (seen.has(el)) continue
          seen.add(el)
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
          if (count === targetIndex) return el
          count++
        }
      } catch (e) {}
    }
    return null
  }, { selectors: allSelectors, targetIndex: idx })

  if (!handle) return null
  return handle.asElement()
}

module.exports = { extractDOM, formatDOM, getLocatorForElement, DEFAULT_TEXT_CHARS }
