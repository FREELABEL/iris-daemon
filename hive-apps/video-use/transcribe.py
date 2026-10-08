"""Transcribe a video LOCALLY with whisper.cpp — a drop-in for video-use's Scribe transcriber.

IRIS Hive Apps (#188385). video-use's own helpers/transcribe.py uploads the audio to ElevenLabs
Scribe. IRIS's transcription policy is sovereign: audio does not leave the machine. This file has
the same command line, the same output path, the same cache rule, and writes the same JSON shape
the other helpers read — {"words": [{"text", "start", "end", "type", "speaker_id"}], "text"} — so
nothing else in video-use changes.

What is lost against Scribe, said rather than faked:
  * diarization — every word is speaker_0 (one-speaker talking heads are unaffected)
  * audio events (laughter, applause) — none are emitted
  * whisper.cpp timestamps are less exact than Scribe's; video-use already pads cuts 30–200 ms

Usage (unchanged):
    python helpers/transcribe.py <video_path> [--edit-dir DIR] [--language en] [--num-speakers N]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MODEL_CANDIDATES = [
    os.environ.get("WHISPER_MODEL", ""),
    str(Path.home() / ".whisper" / "ggml-base.en.bin"),  # where `iris transcribe --install-local` puts it
    str(Path.home() / ".iris" / "models" / "ggml-base.en.bin"),
]
GAP_AS_SPACING = 0.01  # seconds; a gap shorter than this between words gets no spacing entry


def find_whisper() -> str:
    for c in [os.environ.get("WHISPER_CLI", ""), str(Path.home() / ".iris" / "bin" / "whisper-cli"), shutil.which("whisper-cli") or ""]:
        if c and Path(c).exists():
            return c
    sys.exit("whisper-cli not found — install it with: iris transcribe --install-local")


def find_model() -> str:
    for c in MODEL_CANDIDATES:
        if c and Path(c).exists():
            return c
    sys.exit("no whisper model found (expected ~/.whisper/ggml-base.en.bin) — run: iris transcribe --install-local")


def words_from_whisper(doc: dict) -> list[dict]:
    """whisper.cpp -oj with -ml 1 -sow gives one segment per word, offsets in ms. Build Scribe's
    word/spacing sequence from it. Pure, so it can be tested without whisper installed."""
    words: list[dict] = []
    prev_end = None
    for seg in doc.get("transcription", []):
        text = (seg.get("text") or "").strip()
        off = seg.get("offsets") or {}
        if not text or "from" not in off or "to" not in off:
            continue
        start, end = off["from"] / 1000.0, off["to"] / 1000.0
        if text.startswith("[") and text.endswith("]"):  # [BLANK_AUDIO], [MUSIC] — not words
            continue
        if prev_end is not None and start - prev_end >= GAP_AS_SPACING:
            words.append({"text": " ", "start": round(prev_end, 3), "end": round(start, 3), "type": "spacing", "speaker_id": "speaker_0"})
        words.append({"text": text, "start": round(start, 3), "end": round(end, 3), "type": "word", "speaker_id": "speaker_0"})
        prev_end = end
    return words


def transcribe(video: Path, edit_dir: Path, language: str | None) -> Path:
    out = edit_dir / "transcripts" / f"{video.stem}.json"
    if out.exists() and out.stat().st_mtime >= video.stat().st_mtime:
        print(f"cached: {out}")
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    whisper, model = find_whisper(), find_model()
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000", str(wav)], check=True)
        base = Path(tmp) / "w"
        cmd = [whisper, "-m", model, "-f", str(wav), "-oj", "-of", str(base), "-ml", "1", "-sow", "-np"]
        if language:
            cmd += ["-l", language]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
        doc = json.loads((base.with_suffix(".json")).read_text())
    words = words_from_whisper(doc)
    result = {
        "language_code": language or "en",
        "text": " ".join(w["text"] for w in words if w["type"] == "word"),
        "words": words,
        "_source": "whisper.cpp (local) — no audio left this machine",
    }
    out.write_text(json.dumps(result, indent=1))
    print(f"wrote {out} ({sum(1 for w in words if w['type'] == 'word')} words, local)")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("video")
    ap.add_argument("--edit-dir", default=None)
    ap.add_argument("--language", default=None)
    ap.add_argument("--num-speakers", type=int, default=None, help="accepted for compatibility; local transcription has no diarization")
    a = ap.parse_args()
    video = Path(a.video).resolve()
    edit_dir = Path(a.edit_dir).resolve() if a.edit_dir else video.parent / "edit"
    transcribe(video, edit_dir, a.language)


if __name__ == "__main__":
    main()
