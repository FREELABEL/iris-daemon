#!/usr/bin/env node
'use strict'
/**
 * How big is a live-follow delta? (epic #192964, W1 step 2)
 *
 * Reads every Claude Code transcript under ~/.claude/projects and reports, as JSON:
 *   - per APPEND (one JSONL record, which is what one fs change usually carries): the size of the
 *     normalized messages the daemon would push (lib/session-tail messagesFromChunk), JSON-encoded
 *   - per ASSISTANT TURN (every assistant record between two user prompts), the same, summed
 *   - the raw JSONL bytes per append, for comparison (what a naive "push the bytes" would cost)
 * Usage: node scripts/measure-turn-sizes.js [--days 30]
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { messagesFromChunk } = require('../lib/session-tail')

const days = Number((process.argv.find((a, i) => process.argv[i - 1] === '--days')) || 30)
const root = path.join(os.homedir(), '.claude', 'projects')
const cutoff = Date.now() - days * 86400e3
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] }
const summary = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: arr.length ? Math.max(...arr) : null })

const perAppend = []; const perAppendRaw = []; const perTurn = []
let files = 0
for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const d = path.join(root, dir)
  let names = []; try { names = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')) } catch { continue }
  for (const n of names) {
    const f = path.join(d, n)
    let st; try { st = fs.statSync(f) } catch { continue }
    if (st.mtimeMs < cutoff) continue
    files++
    let turn = 0
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const msgs = messagesFromChunk(line + '\n')
      if (!msgs.length) continue
      const bytes = Buffer.byteLength(JSON.stringify(msgs))
      perAppend.push(bytes); perAppendRaw.push(Buffer.byteLength(line) + 1)
      const isUserPrompt = msgs.some((m) => m.role === 'user' && m.type === 'text')
      if (isUserPrompt) { if (turn) perTurn.push(turn); turn = 0 } else turn += bytes
    }
    if (turn) perTurn.push(turn)
  }
}
console.log(JSON.stringify({ host: os.hostname(), days, files, per_append_json_bytes: summary(perAppend), per_append_raw_jsonl_bytes: summary(perAppendRaw), per_assistant_turn_json_bytes: summary(perTurn), over_10kb: { appends: perAppend.filter((b) => b > 10240).length, turns: perTurn.filter((b) => b > 10240).length } }, null, 2))
