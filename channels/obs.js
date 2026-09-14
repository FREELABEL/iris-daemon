/**
 * OBS Studio Channel Driver
 *
 * Controls OBS Studio via WebSocket (obs-websocket v5, port 4455).
 * Provides scene switching, stream/record control, markers, and audio management.
 *
 * Requires: OBS Studio running with WebSocket Server enabled
 * (Tools → WebSocket Server Settings → Enable)
 */

const EventEmitter = require('events')

class OBSChannel extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.obs = null
    this.isRunning = false
    this.lastError = null
  }

  async start() {
    // Dynamic import — obs-websocket-js is ESM
    const OBSWebSocket = (await import('obs-websocket-js')).default
    this.obs = new OBSWebSocket()

    const wsUrl = this.config.wsUrl || 'ws://localhost:4455'
    const password = this.config.password || undefined

    try {
      const result = await this.obs.connect(wsUrl, password, { rpcVersion: 1 })
      console.log(`[obs] Connected to ${wsUrl} (negotiated RPC v${result?.negotiatedRpcVersion || '?'})`)
    } catch (err) {
      this.lastError = err.message
      throw new Error(`OBS connection failed: ${err.message}. Is OBS running with WebSocket Server enabled?`)
    }

    // Subscribe to events
    this.obs.on('StreamStateChanged', (data) => {
      console.log(`[obs] Stream ${data.outputActive ? 'started' : 'stopped'}`)
      this.emit('stream-state', data)
    })

    this.obs.on('RecordStateChanged', (data) => {
      console.log(`[obs] Recording ${data.outputActive ? 'started' : 'stopped'}`)
      this.emit('record-state', data)
    })

    this.obs.on('CurrentProgramSceneChanged', (data) => {
      console.log(`[obs] Scene → ${data.sceneName}`)
      this.emit('scene-changed', data)
    })

    this.obs.on('ConnectionClosed', () => {
      console.log('[obs] Connection closed')
      this.isRunning = false
      this.emit('disconnected')
    })

    this.isRunning = true
    this.lastError = null
  }

  async stop() {
    if (this.obs) {
      try { await this.obs.disconnect() } catch {}
      this.obs = null
    }
    this.isRunning = false
  }

  getStatus() {
    return {
      status: this.isRunning ? 'running' : 'stopped',
      host: this.config.wsUrl || 'ws://localhost:4455',
      lastError: this.lastError,
    }
  }

  // ── Scene Management ──

  async getScenes() {
    const result = await this.obs.call('GetSceneList')
    return {
      current: result.currentProgramSceneName,
      scenes: result.scenes.map(s => ({
        name: s.sceneName,
        index: s.sceneIndex,
      })),
    }
  }

  async setScene(sceneName) {
    await this.obs.call('SetCurrentProgramScene', { sceneName })
    return { ok: true, scene: sceneName }
  }

  // ── Stream Control ──

  async startStream() {
    await this.obs.call('StartStream')
    return { ok: true, action: 'stream_started' }
  }

  async stopStream() {
    await this.obs.call('StopStream')
    return { ok: true, action: 'stream_stopped' }
  }

  async getStreamStatus() {
    const result = await this.obs.call('GetStreamStatus')
    return {
      active: result.outputActive,
      reconnecting: result.outputReconnecting,
      timecode: result.outputTimecode,
      duration: result.outputDuration,
      bytes: result.outputBytes,
      skippedFrames: result.outputSkippedFrames,
      totalFrames: result.outputTotalFrames,
    }
  }

  // ── Recording Control ──

  async startRecord() {
    await this.obs.call('StartRecord')
    return { ok: true, action: 'record_started' }
  }

  async stopRecord() {
    const result = await this.obs.call('StopRecord')
    return { ok: true, action: 'record_stopped', outputPath: result.outputPath }
  }

  async getRecordStatus() {
    const result = await this.obs.call('GetRecordStatus')
    return {
      active: result.outputActive,
      paused: result.outputPaused,
      timecode: result.outputTimecode,
      duration: result.outputDuration,
      bytes: result.outputBytes,
    }
  }

  // ── Markers ──

  /**
   * Record a marker as a SPAN on a durable timeline.
   *
   * OBS has no native marker API, so this used to build a marker object, return it in the
   * HTTP response, and stop. The comment said "we log it for post-production" and nothing
   * was ever written — the marker died with the terminal scrollback. A command whose entire
   * purpose is to mark a moment for later cannot be the one that forgets it.
   *
   * A marker is the cheapest span there is: free, timestamped at the moment, and judged by a
   * human who was watching. It is only worth anything if it outlives the call.
   *
   * ON THE TIME FIELD, WHICH IS THE PART THAT CAN LIE. `t0` is an OFFSET INTO THE RECORDING,
   * in seconds. When nothing is recording there is no offset — the old code fell back to a
   * wall-clock ISO string, and writing that into the same field would produce spans whose
   * times mean two different things with nothing to tell them apart. So when there is no
   * recording, `t0` is null and `unanchored` is true. A span that cannot say when it happened
   * must say so, not guess.
   */
  async createMarker(description) {
    const streamStatus = await this.getStreamStatus().catch(() => null)
    const recordStatus = await this.getRecordStatus().catch(() => null)

    const active = recordStatus?.active || streamStatus?.active || false
    // outputDuration is milliseconds since this output started — the true timeline position.
    const durationMs = recordStatus?.active
      ? recordStatus?.duration
      : streamStatus?.active
        ? streamStatus?.duration
        : null
    const t0 = typeof durationMs === 'number' ? Math.round((durationMs / 1000) * 10) / 10 : null

    const now = new Date()

    // Session key = when this output started, CACHED for the life of the recording.
    //
    // Computing it fresh each time as (now - duration) looks equivalent and is not: the key is
    // truncated to whole seconds, so a second of clock jitter or rounding drift splits one
    // recording's markers across two timeline files. Caught by a unit test where two markers on
    // the same recording produced two sessions — which would have surfaced in production as
    // "half my markers are missing" rather than as an error.
    //
    // A recording RESTART is detected by duration going backwards; that legitimately starts a
    // new session.
    let session
    if (t0 === null) {
      this._markerSession = null
      this._markerLastDuration = null
      session = 'unanchored-' + now.toISOString().slice(0, 10)
    } else {
      const restarted = typeof this._markerLastDuration === 'number' && durationMs < this._markerLastDuration
      if (!this._markerSession || restarted) {
        this._markerSession = new Date(now.getTime() - durationMs).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      }
      this._markerLastDuration = durationMs
      session = this._markerSession
    }

    const span = {
      t0,
      t1: t0,
      kind: 'marker',
      label: description || 'Marker',
      source: 'marker',
      confidence: 1.0,
      unanchored: t0 === null,
      evidence: {
        timecode: recordStatus?.timecode || streamStatus?.timecode || null,
        wall_clock: now.toISOString(),
        record_active: recordStatus?.active || false,
        stream_active: streamStatus?.active || false,
      },
    }

    let timeline = null
    let persisted = false
    let persistError = null
    try {
      const fs = require('fs')
      const path = require('path')
      const dir = path.join(process.env.HOME || '', '.iris', 'timelines')
      fs.mkdirSync(dir, { recursive: true })
      timeline = path.join(dir, session + '.jsonl')
      fs.appendFileSync(timeline, JSON.stringify(span) + '\n')
      persisted = true
    } catch (e) {
      // Report the failure instead of returning ok:true over a marker that went nowhere —
      // which is the exact bug this method is fixing.
      persistError = e.message
    }

    return {
      ok: persisted,
      persisted,
      persist_error: persistError,
      timeline,
      session,
      span,
      // Back-compat: callers (and the CLI's printer) still read `marker`.
      marker: {
        description: span.label,
        timecode: span.evidence.timecode,
        timestamp: span.evidence.wall_clock,
        t0,
        unanchored: span.unanchored,
        stream_active: span.evidence.stream_active,
        record_active: span.evidence.record_active,
      },
    }
  }

  // ── Audio ──

  async setInputMute(inputName, muted) {
    await this.obs.call('SetInputMute', { inputName, inputMuted: muted })
    return { ok: true, input: inputName, muted }
  }

  async getInputMute(inputName) {
    const result = await this.obs.call('GetInputMute', { inputName })
    return { input: inputName, muted: result.inputMuted }
  }

  async getInputList() {
    const result = await this.obs.call('GetInputList')
    return result.inputs.map(i => ({
      name: i.inputName,
      kind: i.inputKind,
      unversioned: i.unversionedInputKind,
    }))
  }

  // ── Sources ──

  async getSceneItems(sceneName) {
    const result = await this.obs.call('GetSceneItemList', { sceneName })
    return result.sceneItems.map(item => ({
      id: item.sceneItemId,
      name: item.sourceName,
      type: item.inputKind,
      enabled: item.sceneItemEnabled,
      index: item.sceneItemIndex,
    }))
  }

  async setSourceEnabled(sceneName, itemId, enabled) {
    await this.obs.call('SetSceneItemEnabled', {
      sceneName,
      sceneItemId: itemId,
      sceneItemEnabled: enabled,
    })
    return { ok: true, itemId, enabled }
  }
}

module.exports = OBSChannel
