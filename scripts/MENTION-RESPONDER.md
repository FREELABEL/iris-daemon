# @heyiris Mention Responder (Step 1)

Closes the gap between the bridge's instant **"CONFIRMED" ack** and a real,
researched reply. Clients @mention `@heyiris` over iMessage; this turns those
into Claude-investigated, client-ready drafts — **approval-gated**, nothing
sends to a client until you say so.

## Primary interface: `iris imessage mentions`

The productized version is wired into the IRIS CLI as subcommands of the
existing `mentions` command (source: `iris-code/.../cmd/platform-imessage.ts`):

```bash
iris imessage mentions                      # list mentions (unchanged)
iris imessage mentions respond [--limit N] [--client x] [--dry-run]   # research + draft
iris imessage mentions drafts  [--all] [--json]                       # review queue
iris imessage mentions show    <id>
iris imessage mentions approve <id|all>     # send (the only client-facing step)
iris imessage mentions reject  <id>
```

`CLAUDE_MODEL=claude-haiku-4-5` keeps bulk sweeps cheap; omit for the default
(stronger) model on a single high-stakes draft. The standalone Node script below
is the reference implementation / proof — same state files, same behavior.

## Pipeline (what runs where)

```
channels/imessage.js  →  ~/.iris/mentions/*.jsonl   [already exists — collection]
                              │
   scripts/mention-responder.js sweep                [NEW — Claude + iris, local]
     · claude -p (read-only tools) inside the freelabel repo
     · classify (bug/feature/question/task/status/other) + investigate
     · draft a client reply, set needs_human when unsure
     · queue → ~/.iris/mention-responder/queue.jsonl
                              │
   ... review ...                                     [you inspect]
                              │
   ... approve ...  →  bridge POST /api/imessage/direct-send  →  client  [LIVE send]
```

State: `~/.iris/mention-responder/` (`processed.json`, `queue.jsonl`).
Idempotent — each mention is keyed by sha1(ts|sender|text); swept once.

## Commands

```bash
cd fl-docker-dev/coding-agent-bridge

# preview what would be processed (no Claude, no send)
node scripts/mention-responder.js sweep --dry-run --since 2026-06-01

# research + draft (default 5 newest unprocessed; calls claude per mention)
node scripts/mention-responder.js sweep --limit 5
node scripts/mention-responder.js sweep --client rashad --since 2026-06-02

# inspect
node scripts/mention-responder.js review          # pending only (--all for sent/rejected)
node scripts/mention-responder.js show <id>       # full message + findings + draft

# act
node scripts/mention-responder.js approve <id>    # send ONE draft to the client
node scripts/mention-responder.js approve all     # send all pending that are NOT needs-human
node scripts/mention-responder.js reject <id>
node scripts/mention-responder.js reset  <id>     # re-queue (clears processed mark)
```

`approve all` deliberately skips `needs-human` drafts — those must be approved
by id, on purpose.

## Env

| var | default |
|---|---|
| `BRIDGE_URL` | `http://localhost:3200` |
| `FREELABEL_REPO` | `/Users/AlexMayo/Sites/freelabel` |
| `CLAUDE_MODEL` | (claude default) |
| `CLAUDE_MAX_TURNS` | `15` |

## Requirements

- `claude` CLI on PATH (headless `-p`), `curl`, Node 18+.
- coding-agent-bridge running on :3200 (the iMessage channel + `direct-send`).

## Roadmap

- **Step 2 (live):** move `IMESSAGE_MENTION_MODE` past `log`, keep the instant
  ack, drop the approval gate only for low-risk classes (status/ETA), keep
  bug/task tickets routed through agent + review.
- Auto-sweep on a timer (launchd) once draft quality is trusted.
- Bug/task class: dispatch an iris-code agent to actually *fix*, not just reply.
