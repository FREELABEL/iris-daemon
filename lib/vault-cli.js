#!/usr/bin/env node
'use strict'

/**
 * `iris-daemon vaults …` — encrypted vaults from a terminal ON THE NODE, without the daemon.
 *
 *   iris-daemon vaults list                         names, bloq, locked, size — never contents
 *   iris-daemon vaults files <name>                 object names (needs the key; prompts for a passphrase vault)
 *   iris-daemon vaults export <name> <file_id> --out <path>
 *   iris-daemon vaults sweep [--days N]             run the retention sweep now (no audit post)
 *
 * create / lock / unlock / destroy go through the running daemon (`iris hive vaults …`): a
 * passphrase vault is unlocked in the DAEMON's memory, which this short-lived process cannot do.
 * `files` and `export` are the human's way to read what a PHI task kept — on this machine only.
 */

const vaults = require('./encrypted-vault')

function hiddenPrompt (q) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stderr.write(s) }
    rl.question(q, (a) => { rl.close(); process.stderr.write('\n'); resolve(a) })
  })
}

async function openFor (name) {
  const e = vaults.getEntry(name)
  if (e.key_source === 'passphrase') vaults.unlock(name, await hiddenPrompt(`Passphrase for vault ${name}: `))
  return vaults.getEntry(name)
}

async function main (argv) {
  const [cmd, ...rest] = argv
  const flag = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined }
  switch (cmd) {
    case 'list':
    case undefined: {
      const list = vaults.listVaults()
      if (rest.includes('--json')) return console.log(JSON.stringify(list, null, 2))
      if (!list.length) return console.log('No encrypted vaults on this node.')
      for (const v of list) console.log(`${v.name.padEnd(28)} bloq=${v.bloq_id || '-'} ${v.locked ? 'locked' : 'unlocked'} key=${v.key_source} files=${v.files} bytes=${v.bytes} escrow=${v.escrow}`)
      return
    }
    case 'files': {
      const name = rest[0]
      await openFor(name)
      for (const f of await vaults.listFiles(name)) console.log(`${f.file_id}  ${String(f.size).padStart(10)}  ${f.created_at}  ${f.kind}  ${f.name || '?'}`)
      return
    }
    case 'export': {
      const [name, fileId] = rest
      const out = flag('out')
      if (!name || !fileId || !out) throw new Error('usage: iris-daemon vaults export <name> <file_id> --out <path>')
      const e = await openFor(name)
      await vaults.exportObject(e, fileId, out)
      console.error(`Wrote ${out} (plaintext, 0600) — delete it when you are done.`)
      return
    }
    case 'sweep': {
      const days = flag('days') ? parseInt(flag('days'), 10) : undefined
      const rows = vaults.sweepRetention({ days })
      console.log(rows.length ? rows.map(r => `${r.vault}: shredded ${r.files} object(s), ${r.bytes} bytes`).join('\n') : 'Nothing older than the retention window.')
      return
    }
    default:
      throw new Error(`unknown command "${cmd}". create/lock/unlock/destroy: use \`iris hive vaults …\` (the daemon must be running).`)
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(e => { console.error(`error: ${e.message}`); process.exit(1) })
}

module.exports = { main }
