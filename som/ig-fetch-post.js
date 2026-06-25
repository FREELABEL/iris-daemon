#!/usr/bin/env node
/**
 * ig-fetch-post.js — authenticated Instagram post fetcher (fixes bug #152145).
 *
 * The fl-api `web_scraper` tool runs from a datacenter IP with no IG session, so
 * Instagram serves a login wall and returns an empty caption/flyer. This script
 * runs LOCALLY through the coding-agent-bridge (residential IP) using a stored,
 * logged-in IG session (som/instagram-auth-<account>.json), so the real post
 * HTML — caption + flyer image — is reachable.
 *
 * Usage:
 *   node ig-fetch-post.js <instagram-post-url> [account] [--json]
 * Output (stdout, JSON):
 *   { ok, url, shortcode, caption, flyerUrl, images: [], account, error? }
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const igUrl = process.argv[2]
const account = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : 'heyiris.io'

function out (obj) { process.stdout.write(JSON.stringify(obj) + '\n') }
function fail (error, extra = {}) { out({ ok: false, url: igUrl || null, error, ...extra }); process.exit(1) }

if (!igUrl || !/instagram\.com\/(p|reel|tv)\//.test(igUrl)) {
  fail('Provide an Instagram post/reel URL (instagram.com/p/… or /reel/…)')
}

const shortcode = (igUrl.match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/) || [])[1] || null
const authFile = path.join(__dirname, `instagram-auth-${account}.json`)
if (!fs.existsSync(authFile)) { fail(`No stored IG session for "${account}" (${path.basename(authFile)})`) }

function cleanCaption (raw) {
  if (!raw) return ''
  // og:title is usually  ‹user› on Instagram: "‹caption›"  — pull the quoted part.
  const m = raw.match(/:\s*"([\s\S]+)"\s*$/)
  let c = m ? m[1] : raw
  // og:description sometimes prefixes engagement: ‹n› likes, ‹n› comments - ‹user› on ‹date›: ‹caption›
  c = c.replace(/^\d[\d,]*\s+likes?,\s*\d[\d,]*\s+comments?\s*-\s*/i, '')
  return c.trim()
}

;(async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const state = JSON.parse(fs.readFileSync(authFile, 'utf-8'))
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 }
    })
    if (state.cookies && state.cookies.length) { await context.addCookies(state.cookies) }
    const page = await context.newPage()

    await page.goto(igUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)

    // Session dead? IG bounces to /accounts/login.
    if (/accounts\/login/.test(page.url())) {
      fail('IG session expired — re-save the login for this account', { account })
    }

    // Pull structured data straight from the post HTML (present once authenticated).
    const data = await page.evaluate(() => {
      const meta = (p) => document.querySelector(`meta[property="${p}"]`)?.content || ''
      let ld = null
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent)
          const node = Array.isArray(j) ? j[0] : j
          if (node && (node.caption || node.articleBody || node.description)) { ld = node; break }
        } catch (e) { /* ignore */ }
      }
      return {
        ogImage: meta('og:image'),
        ogTitle: meta('og:title'),
        ogDescription: meta('og:description'),
        ldCaption: ld ? (ld.caption || ld.articleBody || ld.description || '') : '',
        ldImage: ld && ld.image ? (typeof ld.image === 'string' ? ld.image : (ld.image.url || (Array.isArray(ld.image) ? ld.image[0]?.url || ld.image[0] : ''))) : ''
      }
    })

    const caption = (data.ldCaption && data.ldCaption.length > 0)
      ? data.ldCaption.trim()
      : cleanCaption(data.ogTitle || data.ogDescription)
    const flyerUrl = data.ogImage || data.ldImage || null
    const images = flyerUrl ? [flyerUrl] : []

    if (!caption && !flyerUrl) {
      fail('Post loaded but no caption/image found (HTML shape changed or private post)', { account, shortcode })
    }

    out({ ok: true, url: igUrl, shortcode, account, caption, flyerUrl, images })
  } catch (e) {
    fail(String(e && e.message ? e.message : e))
  } finally {
    await browser.close()
  }
})()
