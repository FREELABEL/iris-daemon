'use strict'

/**
 * portal-recorder.js — "show it once, replay it forever" (#187920, GAP J).
 *
 * WHY THIS EXISTS. The fastest way to get a navigator's know-how into a robot is to let them do
 * the portal flow once, in a real browser on their own node, and keep the steps. Playwright's
 * codegen already records clicks and typing as a spec; what it also records is EVERYTHING TYPED —
 * the portal password, the MFA code, the patient's last name and date of birth — as string
 * literals. A recording pushed as a Hive script as-is would put a working PHI credential and
 * patient identifiers into our cloud database, which is exactly what GAP J exists to prevent.
 *
 * So the raw recording never leaves this function. sanitizeRecording() turns it into a
 * PARAMETERISED script:
 *   - a typed password / username / one-time code → read from the node vault by NAME at run time
 *     (process.env.IRIS_CRED_* — set by the executor from `config.node_credential`, #187915);
 *     the OTP is generated on the node by IRIS_OTP_JS, never stored (#187916);
 *   - every other typed or selected value → a named parameter, `P('LAST_NAME', rec)`, filled from
 *     the current record (a #187919 portal run) or from IRIS_PARAM_LAST_NAME;
 *   - that same value anywhere else in the script (the search result link "Doe, Jane" after
 *     typing "Doe") → the same parameter;
 *   - any remaining literal that LOOKS like PHI (dates, SSN, phone, e-mail, long digit runs) →
 *     a parameter too, because a click on a patient's name is not something anyone typed;
 *   - query-string values in a goto URL → parameters.
 * What remains is selectors and steps. The report says how many of each kind were removed —
 * never the values.
 *
 * Zero dependencies (CommonJS).
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const STR_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g
const VALUE_METHODS = ['fill', 'type', 'pressSequentially', 'selectOption']
const PASSWORD_RE = /pass(word|code|phrase)?\b|pwd|secret|\bpin\b/i
const OTP_RE = /\botp\b|one[- ]?time|verification|security code|\bmfa\b|2fa|totp|authenticat/i
const USERNAME_RE = /user ?(name|id)?\b|\blogin\b|sign[- ]?in/i
// An e-mail field is the login only when a password follows it; otherwise it is record data.
const EMAIL_RE = /e-?mail/i
// Literals that look like a person's data even though nobody typed them (a link to a patient).
const PHI_LITERAL_RES = [
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/, // 03/14/1962
  /\b(19|20)\d{2}-\d{2}-\d{2}\b/, // 1962-03-14
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/, // phone
  /[\w.+-]+@[\w-]+\.[\w.]+/, // e-mail
  /\d{5,}/, // MRN / member id / account number
]

function unquote (lit) {
  const q = lit[0]
  const inner = lit.slice(1, -1)
  if (q === '"') { try { return JSON.parse(lit) } catch { return inner } }
  return inner.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' }[c] || c))
}

function quote (s) { return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` }

function paramName (label, used) {
  let base = String(label || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase().slice(0, 40)
  if (!base || !/^[A-Z]/.test(base)) base = 'VALUE' + (base ? '_' + base : '')
  let name = base
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`
  used.add(name)
  return name
}

/** The human label of the field a value was typed into: getByLabel('Last name') → "Last name". */
function fieldLabel (prefix) {
  const lits = prefix.match(STR_RE) || []
  return lits.length ? unquote(lits[lits.length - 1]) : prefix.replace(/^.*\.(\w+)\($/, '$1')
}

function classify (context, passwordFollows = false) {
  if (PASSWORD_RE.test(context)) return 'password'
  if (OTP_RE.test(context)) return 'otp'
  if (USERNAME_RE.test(context)) return 'username'
  if (passwordFollows && EMAIL_RE.test(context)) return 'username'
  return 'param'
}

const CRED_EXPR = {
  password: "C('IRIS_CRED_PASSWORD')",
  username: "C('IRIS_CRED_USERNAME')",
  otp: 'OTP()',
}

/**
 * Find `.fill(...)`-style value arguments on a line. Returns [{start, end, value, context}],
 * where context is the line up to the value (the locator, and fill's selector argument if any).
 */
function valueArgs (line) {
  const out = []
  for (const m of VALUE_METHODS) {
    const needle = `.${m}(`
    let idx = line.indexOf(needle)
    while (idx !== -1) {
      let pos = idx + needle.length
      const lits = []
      STR_RE.lastIndex = 0
      for (;;) {
        const rest = line.slice(pos)
        const ws = rest.match(/^\s*/)[0].length
        const sub = rest.slice(ws)
        const lm = sub.match(/^('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/)
        if (!lm) break
        lits.push({ start: pos + ws, end: pos + ws + lm[0].length, lit: lm[0] })
        pos = pos + ws + lm[0].length
        const sep = line.slice(pos).match(/^\s*,\s*/)
        if (!sep) break
        pos += sep[0].length
      }
      if (lits.length) {
        const v = lits[lits.length - 1] // the VALUE is the last string argument
        out.push({ start: v.start, end: v.end, value: unquote(v.lit), context: line.slice(0, v.start) })
      }
      idx = line.indexOf(needle, idx + needle.length)
    }
  }
  return out.sort((a, b) => b.start - a.start) // right-to-left so splicing keeps offsets valid
}

/**
 * Turn a raw codegen spec into a parameterised Hive script.
 * @param {string} source  raw `playwright codegen --target playwright-test` output
 * @param {object} opts    { name, vault, phiValues: string[] (sample-record values to always strip) }
 * @returns {{ script: string, params: {name:string,label:string}[], credential: string|null,
 *             removed: {password:number, username:number, otp:number, param:number, echoed:number, phi_literal:number, url_query:number} }}
 */
function sanitizeRecording (source, opts = {}) {
  const vault = opts.vault ? String(opts.vault) : null
  if (vault && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(vault)) throw new Error('vault name must be a node-vault NAME')
  const removed = { password: 0, username: 0, otp: 0, param: 0, echoed: 0, phi_literal: 0, url_query: 0 }
  const used = new Set()
  const params = []
  const known = new Map() // typed value → replacement expression (so echoes reuse it)

  const lines = String(source).split(/\r?\n/)
  const start = lines.findIndex(l => /^\s*test\(/.test(l))
  let end = -1
  for (let i = lines.length - 1; i > start; i--) if (/^\s*\}\);?\s*$/.test(lines[i])) { end = i; break }
  const body = start >= 0 && end > start ? lines.slice(start + 1, end) : lines.filter(l => !/^\s*import\b/.test(l))

  // Generated expressions are held as opaque tokens until the end, so pass 2 (which rewrites
  // string literals) never mistakes the 'LAST_NAME' inside P('LAST_NAME', rec) for page text.
  const exprs = []
  const tok = (expr) => { exprs.push(expr); return `\u0001${exprs.length - 1}\u0001` }
  const addParam = (label) => {
    const name = paramName(label, used)
    params.push({ name, label: String(label || name).slice(0, 80) })
    return tok(`P('${name}', rec)`)
  }
  const isPasswordFill = (l) => valueArgs(l).some(a => PASSWORD_RE.test(a.context))

  // Pass 1 — typed values.
  const step1 = body.map((line, li) => {
    let out = line
    for (const a of valueArgs(line)) {
      if (a.value === '') continue
      let kind = classify(a.context, body.slice(li + 1, li + 4).some(isPasswordFill))
      if (kind !== 'param' && !vault) kind = 'param' // no vault named: still never keep the value
      let expr
      if (known.has(a.value)) expr = known.get(a.value)
      else if (kind === 'param') { expr = addParam(fieldLabel(a.context)); known.set(a.value, expr) } else { expr = tok(CRED_EXPR[kind]); known.set(a.value, expr) }
      removed[kind]++
      out = out.slice(0, a.start) + expr + out.slice(a.end)
    }
    return out
  })

  // Values that must never survive anywhere: what was typed, plus declared sample-record values.
  const secretsLongestFirst = [...known.keys(), ...(opts.phiValues || []).map(String)]
    .filter(v => v.length >= 2).sort((a, b) => b.length - a.length)

  // Pass 2 — every remaining literal: echoes of typed values, PHI-looking text, URL queries.
  const step2 = step1.map(line => line.replace(STR_RE, (lit) => {
    const v = unquote(lit)
    if (/^https?:\/\//.test(v)) {
      let u
      try { u = new URL(v) } catch { return lit }
      // A path segment can be the patient too (/patients/0012345, /members/doe-jane).
      const segIsRecord = (seg) => /\d{5,}/.test(seg) || secretsLongestFirst.some(x => decodeURIComponent(seg).includes(x))
      const segs = u.pathname.split('/')
      if (![...u.searchParams.keys()].length && !segs.some(segIsRecord)) return lit
      const esc = (t) => t.replace(/[`$\\]/g, '\\$&')
      const pathOut = segs.map(seg => {
        if (!segIsRecord(seg)) return esc(seg)
        removed.url_query++
        return `\${encodeURIComponent(${addParam('path')})}`
      }).join('/')
      const parts = [...u.searchParams.entries()].map(([k]) => {
        removed.url_query++
        return `${esc(encodeURIComponent(k))}=\${encodeURIComponent(${addParam(k)})}`
      })
      return '`' + esc(u.origin) + pathOut + (parts.length ? '?' + parts.join('&') : '') + '`'
    }
    const hit = secretsLongestFirst.find(s => v.includes(s))
    if (hit) {
      removed.echoed++
      if (v === hit) return known.get(hit) || addParamFor(hit)
      // A literal that CONTAINS a typed value ("Doe, Jane" after typing "Doe"): the rest of it
      // is as much the patient as the part that was typed, so the whole literal becomes one.
      return addParam('match')
    }
    if (PHI_LITERAL_RES.some(re => re.test(v))) { removed.phi_literal++; return addParam('record_text') }
    return lit
  }))

  function addParamFor (v) { const e = addParam('value'); known.set(v, e); return e }

  // Split the flow: steps before the first per-record parameter are the login/setup, done once;
  // the rest is the per-record flow, repeated for each record of a #187919 portal run.
  const restore = (l) => l.replace(/\u0001(\d+)\u0001/g, (_, i) => exprs[Number(i)])
  const isRecTok = (l) => /\u0001(\d+)\u0001/.test(l) && [...l.matchAll(/\u0001(\d+)\u0001/g)].some(m => exprs[Number(m[1])].startsWith('P('))
  const firstRecRaw = step2.findIndex(isRecTok)
  const restored = step2.map(restore)
  const firstRec = firstRecRaw
  const setup = firstRec === -1 ? restored : restored.slice(0, firstRec)
  const perRecord = firstRec === -1 ? [] : restored.slice(firstRec)
  const title = String(opts.name || 'recorded-portal-flow').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()

  const header = [
    `// ${title} — recorded on a node with \`iris-portal-record\` (#187920). Typed secrets and record`,
    '// values were replaced with parameters; credentials come from the node vault by NAME.',
    '// iris: requires=browser',
    '// iris: recorded=codegen',
    ...(vault ? [`// iris: credential=${vault}`] : []),
    ...params.map(p => `// iris: arg=${p.name}`),
  ]
  const script = [
    ...header,
    "import { test } from '@playwright/test';",
    "import { execFileSync } from 'child_process';",
    '',
    '// A credential from the node vault (#187915) — set on this process only, never in the script.',
    "const C = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`node-vault credential missing: ${k} (set config.node_credential)`); return v; };",
    '// The one-time code is generated on the node from the vault seed (#187916).',
    "const OTP = (): string => execFileSync(process.execPath, [C('IRIS_OTP_JS'), C('IRIS_CRED_NAME')]).toString().trim();",
    '// A parameter: from the current record (portal run, #187919) or IRIS_PARAM_<NAME>.',
    "const P = (name: string, rec: any): string => { const v = rec && (rec[name] ?? rec[name.toLowerCase()]); if (v !== undefined && v !== null) return String(v); const e = process.env['IRIS_PARAM_' + name]; if (e === undefined) throw new Error(`missing parameter ${name}`); return e; };",
    '',
    `test(${quote(title)}, async ({ page }) => {`,
    '  const rec: any = null;',
    ...setup.map(l => l),
    '  const perRecord = async (rec: any) => {',
    ...perRecord.map(l => '  ' + l),
    '  };',
    '  if (process.env.IRIS_PORTAL_RECORDS && process.env.IRIS_PORTAL_LIB) {',
    '    const { forEachRecord, loadRecords } = require(process.env.IRIS_PORTAL_LIB);',
    '    await forEachRecord(loadRecords(), (r: any) => perRecord(r));',
    '  } else {',
    '    await perRecord(null);',
    '  }',
    '});',
    '',
  ].join('\n')

  return { script, params, credential: vault, removed }
}

/** argv for `npx playwright codegen` — headed by nature; the person drives it. */
function codegenArgs ({ url, outFile, browser = 'chromium' }) {
  if (!url || !/^https?:\/\//.test(url)) throw new Error('record: --url must be an http(s) URL')
  return ['playwright', 'codegen', '--target', 'playwright-test', '--browser', browser, '-o', outFile, url]
}

/**
 * A private scratch dir for the RAW recording, which holds typed secrets (and whatever patient
 * detail was typed into the portal) until sanitised. Encrypted vaults: it lives under the vaults
 * root (~/.iris/vaults/.scratch, 0700) rather than the system temp dir — /tmp is shared, often
 * listable, and on some machines a different (unencrypted) volume from the home directory that
 * full-disk-encryption routing vouches for. Still shredded the moment sanitising ends.
 */
function rawRecordingPath (baseDir = null) {
  let base = baseDir
  if (!base) {
    try { base = path.join(require('./encrypted-vault').rootDir(), '.scratch') } catch { base = os.tmpdir() }
  }
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const dir = fs.mkdtempSync(path.join(base, 'iris-record-'))
  try { fs.chmodSync(dir, 0o700) } catch { /* windows */ }
  return path.join(dir, 'raw.spec.ts')
}

/** Destroy the raw recording: it contains whatever the person typed. */
function shredRaw (file) {
  try {
    const size = fs.statSync(file).size
    fs.writeFileSync(file, Buffer.alloc(size))
  } catch { /* already gone */ }
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }) } catch { /* best effort */ }
}

module.exports = { sanitizeRecording, codegenArgs, rawRecordingPath, shredRaw, valueArgs, classify }
