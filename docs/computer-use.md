# computer_use — desktop tasks through Cua Driver (#187922)

A Hive task type that drives a desktop app on one of our nodes. The daemon runs the steps through
[Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) (MIT), on the node's own
desktop, in a throwaway [Lume](https://github.com/trycua/cua/tree/main/libs/lume) macOS VM (MIT),
or in a throwaway Linux container. No relay is involved, so no third party sees the screen.

Licence checked on 2026-10-05 against the repo's `LICENSING.md`. Cua Driver, Lume, the `cua` CLI
and the SDKs are MIT. These parts are **not** MIT, and we do not use them:

- Cua Spaces, cua-spacesd and the streaming/teleport crates: FSL-1.1-MIT, with a hosted relay.
- The `trycua/cua-xfce` image: it runs cua-spacesd.
- The optional `cua-perception` extension: its OmniParser icon detector is AGPL-3.0-only.
- `libs/python/som`: AGPL-3.0-or-later.

## Task

```json
{ "type": "computer_use", "title": "sample entry", "prompt": "enter the sample rows",
  "config": { "desktop": "macos",
              "steps": [ {"tool": "list_apps"},
                         {"tool": "type_text", "args": {"text": "sample row 1"}} ],
              "agent_id": 123, "run_id": "optional — feeds the run's live view" } }
```

- `desktop` is required: `host`, `macos` (Lume VM) or `linux` (container). It becomes a routing
  requirement (`desktop_host`, `desktop_macos` or `desktop_linux`). A task waits until a node that
  reports that desktop is online.
- `tool` must be in the Cua Driver contract allowlist. `escalate_session` is excluded.
- Before every step the daemon calls `POST /api/v6/node-agent/tasks/{id}/steps`. A
  `continue:false` answer (agent paused, task cancelled) stops the task before its next action. If
  the endpoint can't be reached, the task also stops (it fails closed).
- PHI tasks: screenshots are written to `~/.iris/…/tasks/<id>/computer-use/` with mode 0600. They
  are never uploaded and are stripped from every step event and result.
- `upload_screenshots: true` uploads screenshots as task artifacts, for non-PHI tasks only.

## Install on a node

Cua Driver and Lume both send telemetry by default. The daemon turns it off for every process it
starts (`DO_NOT_TRACK=1`, `CUA_TELEMETRY=0`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`,
`LUME_TELEMETRY_ENABLED=false`). For manual use, also run `cua-driver telemetry disable` and
`lume config telemetry disable`. The driver's update check is separate, and those switches do not
turn it off. Block it at the firewall or tailnet ACL if "no traffic leaves" must be strict.

**host** (macOS 14+, or x86_64 Linux with X11/XWayland and AT-SPI 2):

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
open -n -g -a CuaDriver --args serve        # macOS; on Linux: cua-driver serve (inside the session)
cua-driver permissions grant                # macOS: Accessibility + Screen Recording
cua-driver call list_apps                   # should list open apps
```

**macos** (Apple Silicon host with `lume`): prepare a base VM once, then each task clones it.

```bash
lume pull macos-tahoe-cua:26.5.2 iris-cua-base && lume run iris-cua-base
# in the VM display: install cua-driver, run `cua-driver permissions grant`, approve the prompts,
# add the node's SSH public key to lume@ ~/.ssh/authorized_keys, then:
lume stop iris-cua-base
```

Set `IRIS_CUA_LUME_BASE` to use a different base name. The daemon reaches the VM over SSH on the
host's VM network (`lume get <vm> --format json` gives its IP).

**linux** (Docker): build our own image. Start from an Xfce base, add `pip install cua-driver`
(pinned by upstream `libs/xfce/requirements-cua-driver.txt`), have it start an X session and
`cua-driver serve`, and tag it `iris/cua-desktop-linux:local` (or set `IRIS_CUA_LINUX_IMAGE`).
Containers run with `--network none`.

## Not verified here

This dev box has no desktop and no Apple Silicon, so the tests use a fake driver. These items have
not been checked against a real install:

- `lume delete <vm> --force` (teardown): the flag is not in the docs we read.
- The JSON shape of `cua-driver call` output.
- Whether `ssh … cua-driver call` reaches the logged-in daemon in the guest. The docs say it does
  for `cua-driver mcp`.
