#!/usr/bin/env node
'use strict'

/**
 * `iris-daemon creds …` and `iris-otp <name>` — the node vault from a terminal (#187915, #187916).
 *
 *   iris-daemon creds add <name> [--type login] [--username U] [--url URL] [--totp] [--password-stdin]
 *   iris-daemon creds list            names + type + whether a TOTP seed is held. Never a value.
 *   iris-daemon creds remove <name>
 *   iris-otp <name>                   the current RFC 6238 code, generated here.
 *
 * Secrets are read from a hidden prompt (or stdin with --password-stdin: line 1 password, line 2
 * TOTP seed) rather than flags, because a flag lands in shell history and in `ps` for every local
 * user. `--totp-secret <seed>` is accepted for parity with the ticket's wording, with a warning.
 * `--local` is accepted and ignored: the node vault is only ever local.
 */

const vault = require('./node-vault')

function parse (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2)
      const next = argv[i + 1]
      if (inline !== undefined) out[k] = inline
      else if (['type', 'username', 'url', 'totp-secret', 'digits', 'period', 'algorithm'].includes(k) && next !== undefined) { out[k] = next; i++ } else out[k] = true
    } else out._.push(a)
  }
  return out
}

function readStdin () {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => { buf += d })
    process.stdin.on('end', () => resolve(buf))
  })
}

function prompt (question) {
  return new Promise((resolve) => {
    const readline = require('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    // Mute the echo: what is typed is a secret.
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stderr.write(s) }
    rl.question(question, (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer) })
  })
}

async function main (argv = process.argv.slice(2), io = { out: console.log, err: console.error }) {
  const [cmd, name] = argv
  const opts = parse(argv.slice(1))
  try {
    if (cmd === 'add') {
      if (!name || name.startsWith('--')) throw new Error('usage: creds add <name> [--username U] [--url URL] [--totp] [--password-stdin]')
      let password = null
      let totpSecret = typeof opts['totp-secret'] === 'string' ? opts['totp-secret'] : null
      if (totpSecret) io.err('warning: --totp-secret leaves the seed in your shell history; prefer --totp (prompt) next time')
      if (opts['password-stdin']) {
        const lines = (await readStdin()).split(/\r?\n/)
        password = lines[0] || null
        if (!totpSecret && lines[1]) totpSecret = lines[1].trim()
      } else if (process.stdin.isTTY) {
        password = (await prompt(`Password for ${name} (blank for none): `)) || null
        if (opts.totp && !totpSecret) totpSecret = (await prompt('TOTP secret (base32): ')).trim() || null
      }
      const s = vault.addCredential(name, {
        type: opts.type || 'login',
        username: typeof opts.username === 'string' ? opts.username : null,
        url: typeof opts.url === 'string' ? opts.url : null,
        password,
        totp_secret: totpSecret,
        digits: opts.digits ? Number(opts.digits) : undefined,
        period: opts.period ? Number(opts.period) : undefined,
        algorithm: typeof opts.algorithm === 'string' ? opts.algorithm.toLowerCase() : undefined,
      })
      io.out(`stored "${s.name}" in this node's vault (${s.type}${s.has_totp ? ', TOTP' : ''}). Tasks use it with config.node_credential = "${s.name}".`)
      return 0
    }
    if (cmd === 'list' || cmd === 'ls') {
      const names = vault.listNames()
      if (opts.json) { io.out(JSON.stringify(names)); return 0 }
      if (!names.length) { io.out('no credentials in this node\'s vault'); return 0 }
      for (const c of names) io.out(`${c.name}\t${c.type}${c.has_totp ? '\ttotp' : ''}`)
      return 0
    }
    if (cmd === 'remove' || cmd === 'rm') {
      if (!name) throw new Error('usage: creds remove <name>')
      io.out(vault.removeCredential(name) ? `removed "${name}"` : `no credential named "${name}"`)
      return 0
    }
    if (cmd === 'otp') {
      if (!name) throw new Error('usage: iris-otp <name>')
      io.out(vault.otpFor(name))
      return 0
    }
    io.err('usage: iris-daemon creds {add|list|remove} …   |   iris-otp <name>')
    return 2
  } catch (e) {
    io.err(`error: ${e.message}`)
    return 1
  }
}

if (require.main === module) {
  main().then(code => process.exit(code))
}

module.exports = { main, parse }
