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


/**
 * Which interpreter runs a script FILE, chosen by extension.
 *
 * Three call sites shared one line of this logic and one bug in it:
 * `interpreters[ext] || '/bin/bash'` (task-executor execute_file,
 * daemon/script-runner.js, daemon/schedule-registry.js). The fallback is the
 * whole problem — an unknown extension on a Windows node resolved to a shell
 * that is not installed, so the dispatch died at spawn with a syscall error.
 *
 * `.sh` on Windows is reported as UNSUPPORTED rather than handed to some
 * best-guess interpreter. There is no honest way to run a bash script on a host
 * with no bash, and saying so before spawning is the difference between "this
 * node cannot run .sh" and "spawn /bin/bash ENOENT" — the second is what got
 * this filed twice and diagnosed neither time (#185143, #184733).
 */
function interpreterFor (ext, platform = PLATFORM()) {
  const e = String(ext || '').toLowerCase()
  const mode = platform === 'win32' ? null : '755'

  // Interpreters that exist under the same name on every platform.
  const portable = { '.py': 'python3', '.js': 'node' }
  if (portable[e]) return { cmd: portable[e], args: [], mode, unsupported: false }
  if (e === '.ts') return { cmd: 'npx', args: ['ts-node'], mode, unsupported: false }

  if (platform === 'win32') {
    if (e === '.cmd' || e === '.bat') {
      return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], mode: null, unsupported: false }
    }
    if (e === '.ps1') {
      return {
        cmd: 'powershell.exe',
        // -NoProfile: a task must not inherit whatever an operator put in their
        // profile. -ExecutionPolicy Bypass: the default policy refuses unsigned
        // scripts, and every script we generate is unsigned.
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
        mode: null,
        unsupported: false
      }
    }
    if (e === '.sh') {
      return {
        cmd: null,
        args: [],
        mode: null,
        unsupported: true,
        reason: 'This node is Windows and has no bash, so a .sh script cannot run here. ' +
          'Nothing was executed. Send a .ps1, a .cmd, or a portable interpreter (.py/.js).'
      }
    }
    // Anything else: hand it to the platform shell, which at least exists.
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], mode: null, unsupported: false }
  }

  return { cmd: '/bin/bash', args: [], mode, unsupported: false }
}

/**
 * A script this daemon GENERATES line by line, rather than one a caller supplied.
 *
 * `scaffold_workspace` and the `deploy_project` builders assemble bash — `set -e`,
 * `echo "..."`, `cd`, `npm ci` — write it to a .sh and spawn bash on it. Pointing
 * cmd.exe at that text would run something, which is worse than running nothing:
 * cmd has no `set -e`, so a failed `npm ci` in the middle would be followed by
 * every remaining line and the task would report success.
 *
 * So Windows gets PowerShell, which can actually express the guarantee:
 *   set -e            ->  $ErrorActionPreference = 'Stop'
 *   (native non-zero) ->  an explicit $LASTEXITCODE check after every line
 *
 * That second line is the one that matters and the one that is easy to miss.
 * $ErrorActionPreference governs POWERSHELL errors; a native executable exiting
 * non-zero is not one. Without the check, `npm ci` failing would sail straight
 * past the Stop preference — silent success, the exact failure mode this whole
 * bug family keeps producing.
 */
function generatedScriptFor (workspaceDir, name, lines, platform = PLATFORM()) {
  const path = require('path')
  const body = Array.isArray(lines) ? lines : String(lines).split('\n')

  if (platform === 'win32') {
    const guarded = []
    guarded.push("$ErrorActionPreference = 'Stop'")
    for (const line of body) {
      guarded.push(line)
      // After every emitted line, fail the script if the last native command did.
      guarded.push('if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { exit $LASTEXITCODE }')
    }
    return {
      scriptPath: path.win32.join(workspaceDir, `${name}.ps1`),
      content: guarded.join('\r\n') + '\r\n',
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.win32.join(workspaceDir, `${name}.ps1`)],
      mode: null,
      // Callers can tell the script they handed in is not the script that will
      // run, which matters when they log it or show it to an operator.
      translated: true
    }
  }

  return {
    scriptPath: path.posix.join(workspaceDir, `${name}.sh`),
    content: ['set -e', ...body].join('\n') + '\n',
    cmd: '/bin/bash',
    args: [path.posix.join(workspaceDir, `${name}.sh`)],
    mode: '755',
    translated: false
  }
}


/**
 * A task type whose script is BASH THAT WE GENERATED, running on a node that has
 * no bash.
 *
 * Six typed paths (remotion_carousel, discover, run_persistent, deploy_project x2,
 * and the client-sync branch) build a multi-line bash script — pm2 invocations,
 * curl retry loops with $MAX_RETRIES, `set -e`, POSIX test syntax — write it to a
 * .sh, and spawn bash on it. There is no faithful mechanical translation of those
 * to PowerShell, and a half-translation is the worst outcome available: it would
 * run SOME of the script on a client's server and report success.
 *
 * So they refuse, by name, before spawning anything. That is a real improvement
 * over the status quo even though it runs nothing — `spawn /bin/bash ENOENT` was
 * read as "my command failed" and sent people to debug their own script twice
 * (#185143, #184733). "This task type needs bash and this node is Windows" sends
 * them somewhere true.
 */
function posixScriptPlan (scriptPath, taskType, platform = PLATFORM()) {
  if (platform === 'win32') {
    return {
      unsupported: true,
      reason: `The "${taskType}" task builds a bash script, and this node is Windows ` +
        `(no bash). NOTHING WAS EXECUTED — this is a node capability limit, not a ` +
        `failure of your task. Run this task type on a macOS or Linux node, or use ` +
        `\`iris hive run\` which works on every platform.`
    }
  }
  return { unsupported: false, cmd: '/bin/bash', args: [scriptPath] }
}

module.exports = { shellFor, scriptFor, pathDelimiterFor, describeSpawnFailure, interpreterFor, generatedScriptFor, posixScriptPlan }
