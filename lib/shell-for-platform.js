'use strict'

/**
 * Which shell runs a free-form command, and how PATH is spelled.
 *
 * The hive executor hardcoded `/bin/bash` and joined PATH with ':'. On the Windows
 * node (qb-host-vanguard) every dispatch died with `spawn /bin/bash ENOENT` —
 * #185143, and #184733 before it. The operator-visible error named a syscall and a
 * path, which reads as "the task failed" rather than "this node has no shell I know
 * how to call", so it was filed twice and diagnosed neither time.
 *
 * `platform` is a PARAMETER on purpose. The Windows behaviour has to be assertable
 * from a Mac; a helper that reads process.platform internally can only ever be
 * tested on the platform that already worked.
 */

const PLATFORM = () => process.platform

/**
 * The shell invocation for a free-form command string.
 *
 * Windows gets cmd.exe — not PowerShell. cmd.exe is present on every Windows
 * install including Server Core, needs no execution-policy grant, and its `/c`
 * contract is stable. `/d` skips AutoRun registry commands (which would otherwise
 * run before every hive task) and `/s` makes quoting of the trailing string
 * predictable instead of depending on how many quotes it contains.
 */
function shellFor (command, platform = PLATFORM()) {
  if (platform === 'win32') {
    return {
      cmd: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command]
    }
  }
  return { cmd: '/bin/bash', args: ['-c', command] }
}

/** PATH separator for the TARGET platform — ';' on Windows, ':' elsewhere. */
function pathDelimiterFor (platform = PLATFORM()) {
  return platform === 'win32' ? ';' : ':'
}

/**
 * Turn a spawn error into something an operator can act on.
 *
 * Only ENOENT on the interpreter itself means "this node cannot run commands of
 * this kind". Everything else keeps its own code — relabelling an EACCES as a
 * missing shell would send someone to install bash when the real problem is a
 * permission bit.
 */
function describeSpawnFailure (err, shellPath, platform = PLATFORM()) {
  const code = err && err.code
  if (code === 'ENOENT') {
    return `Cannot run the command: the shell "${shellPath}" does not exist on this node ` +
      `(platform ${platform}). This is a node capability problem, not a failure of your ` +
      `command — nothing was executed. If this is a Windows node, the daemon should be ` +
      `using cmd.exe; update the IRIS bridge on this machine.`
  }
  return `Failed to start the shell "${shellPath}" on this node (platform ${platform}): ` +
    `${code || 'unknown error'} — ${err && err.message}`
}


/**
 * Where to write a free-form command as a SCRIPT, and how to run it.
 *
 * This is the path `iris hive run <node> "<cmd>"` actually takes — task type
 * `sandbox_execute` writes the command to a file and spawns an interpreter on it.
 * Fixing only the `bash -c` case left the Windows failure exactly where it was;
 * a real dispatch found that, a unit test of the other function could not.
 *
 * The EXTENSION is part of the platform contract, not decoration: cmd.exe cannot
 * execute a .sh, and Windows has no exec bit, so chmod is not merely unnecessary
 * there — `mode: null` says "do not try".
 */
function scriptFor (workspaceDir, command, platform = PLATFORM()) {
  const path = require('path')
  if (platform === 'win32') {
    return {
      scriptPath: path.win32.join(workspaceDir, 'task-script.cmd'),
      // cmd.exe echoes every line of a batch file before running it, which doubles
      // the task output and interleaves commands with their results.
      content: `@echo off\r\n${String(command).replace(/\r?\n/g, '\r\n')}\r\n`,
      cmd: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', path.win32.join(workspaceDir, 'task-script.cmd')],
      mode: null
    }
  }
  const scriptPath = path.posix.join(workspaceDir, 'task-script.sh')
  return { scriptPath, content: command, cmd: '/bin/bash', args: [scriptPath], mode: '755' }
}

module.exports = { shellFor, scriptFor, pathDelimiterFor, describeSpawnFailure }
