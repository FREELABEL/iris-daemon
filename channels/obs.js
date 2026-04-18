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

  async createMarker(description) {
    // OBS doesn't have a native marker API — we log it for post-production
    const streamStatus = await this.getStreamStatus().catch(() => null)
    const recordStatus = await this.getRecordStatus().catch(() => null)
    const timecode = streamStatus?.timecode || recordStatus?.timecode || new Date().toISOString()

    return {
      ok: true,
      marker: {
        description: description || 'Marker',
        timecode,
        timestamp: new Date().toISOString(),
        stream_active: streamStatus?.active || false,
        record_active: recordStatus?.active || false,
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
