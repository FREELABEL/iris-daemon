#!/usr/bin/env bash
# Install video-use (browser-use, MIT) on a Hive node with LOCAL transcription (#188385).
# Idempotent. Needs: git, python3 (venv), ffmpeg, and `iris transcribe --install-local` done.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${VIDEO_USE_HOME:-$HOME/.iris/apps/video-use}"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required"; exit 3; }
[ -x "$HOME/.iris/bin/whisper-cli" ] || command -v whisper-cli >/dev/null || { echo "run: iris transcribe --install-local"; exit 3; }
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q --ff-only; else git clone -q --depth 1 https://github.com/browser-use/video-use.git "$APP"; fi
# uv builds the environment without ensurepip, which many Linux pythons ship without
# (python3-venv is a separate apt package). It is also what video-use's own install prefers.
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
if [ ! -x "$UV" ]; then python3 -m pip install -q --user uv 2>/dev/null || "$HOME/.local/bin/pip" install -q --user --break-system-packages uv; fi
"$UV" venv -q "$APP/.venv"
"$UV" pip install -q --python "$APP/.venv/bin/python" requests librosa matplotlib pillow numpy
# Swap the cloud transcriber for the local one; keep the original beside it, unused.
[ -f "$APP/helpers/transcribe_scribe.py" ] || cp "$APP/helpers/transcribe.py" "$APP/helpers/transcribe_scribe.py"
cp "$HERE/transcribe.py" "$APP/helpers/transcribe.py"
# transcribe_batch.py calls into transcribe.py; make it local too by pointing it at the same module.
grep -q "IRIS-LOCAL" "$APP/SKILL.md" || cat >> "$APP/SKILL.md" <<'NOTE'

## IRIS-LOCAL — this install transcribes on this machine
`helpers/transcribe.py` runs whisper.cpp locally (word timestamps, same JSON shape). **No ElevenLabs
key is needed or wanted — never ask for one, never call Scribe.** There is no diarization (every
word is speaker_0) and no audio events. Run every helper with `$VIDEO_USE_HOME/.venv/bin/python`.
NOTE
echo "video-use installed at $APP (local transcription)"
