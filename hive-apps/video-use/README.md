# video-use on a Hive node — with local transcription (#188385)

[video-use](https://github.com/browser-use/video-use) (browser-use, MIT) lets a coding agent edit raw
footage: cut fillers and dead space, grade, burn subtitles, render overlays, and check every cut.
Its transcriber uploads audio to ElevenLabs Scribe, which IRIS's sovereign transcription policy
forbids. `transcribe.py` here is a drop-in replacement that runs whisper.cpp **on the node**: same
command line, output path, cache rule and JSON shape, so nothing else in video-use changes.

```bash
iris transcribe --install-local          # whisper-cli + model, once per node
bash hive-apps/video-use/install.sh      # clone, uv env, swap the transcriber, mark SKILL.md
```

Then point an agent at a folder of footage with `$VIDEO_USE_HOME/SKILL.md` (default
`~/.iris/apps/video-use`).

**Measured 2026-10-08 on iris-hive-001:** a 2-minute recording became a 108.4 s cut with 395
subtitle cues and 14 cuts, all passing video-use's self-check. No audio left the machine.

**What is lost against Scribe, said rather than faked:**
- no diarization (every word is speaker_0);
- no audio events;
- whisper.cpp word timings drift by up to ~1.5 s across pauses. In the test the agent placed cuts
  on measured silences instead, and built captions from its own timing. Next step: whisper.cpp
  `--dtw` token timestamps.
