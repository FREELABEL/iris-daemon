#!/usr/bin/env node
'use strict'
// Attempted, sent, undeliverable, unknown, failed and delivery rate, per campaign per day (#192164).
//   node delivery-report.js [--json] [--days=7]
// Reads the journal the batch writes. Counts only. delivery_rate = sent / everything that went out
// (failures say nothing about the person); unknown lowers it, so it is a floor.
const { readJournal, journalFile, summarize } = require('./helpers/dm-guard')

function main (argv = process.argv.slice(2), now = Date.now()) {
  const days = Number((argv.find(a => a.startsWith('--days=')) || '--days=7').split('=')[1]) || 7
  const since = new Date(now - days * 86400000).toISOString().slice(0, 10)
  const rows = summarize(readJournal(journalFile())).filter(r => r.date >= since)
  if (argv.includes('--json')) { console.log(JSON.stringify(rows)); return }
  if (!rows.length) { console.log(`No sends in the journal for the last ${days} days.`); return }
  for (const r of rows) {
    const rate = r.delivery_rate === null ? 'n/a' : `${Math.round(r.delivery_rate * 100)}%`
    console.log(`${r.date}  ${r.campaign} (@${r.account})  attempted ${r.attempted}  sent ${r.sent}  undeliverable ${r.undeliverable}  unknown ${r.delivered_unknown}  failed ${r.failed}  rate ${rate}`)
  }
}

if (require.main === module) main()
module.exports = { main }
