/**
 * A2A Protocol Executor — wraps the existing TaskExecutor as an A2A-compliant AgentExecutor.
 *
 * The @a2a-js/sdk DefaultRequestHandler expects:
 *   execute(requestContext, eventBus) → Promise<void>
 *
 * The executor publishes Task / status-update / artifact events to eventBus,
 * then calls eventBus.finished(). Internally it dispatches to our existing
 * fire-and-forget TaskExecutor.execute() and intercepts cloud.submitResult()
 * to capture task outcomes.
 */

const { v4: uuidv4 } = require('crypto')
const { TaskExecutor } = require('./task-executor')

// Task type metadata for Agent Card skills
const TASK_TYPE_META = {
  som_batch: {
    name: 'SOM Outreach Batch',
    description: 'Run Instagram DM outreach campaigns via Playwright. Supports limit, dry run, campaign selection.',
    tags: ['outreach', 'instagram', 'playwright', 'browser'],
    examples: ['limit=15', 'only=courses,beatbox limit=10 dry=1', 'all=1 limit=10 mode=email']
  },
  discover: {
    name: 'YouTube Content Discovery',
    description: 'Scrape YouTube feed and send to n8n marketing pipeline.',
    tags: ['youtube', 'scraping', 'content', 'browser'],
    examples: ['import-yt-feed limit=50', 'import-yt-feed dry=1']
  },
  message: {
    name: 'Cross-Node Message',
    description: 'Send a notification or text message to this node operator.',
    tags: ['notification', 'message']
  },
  custom_playwright: {
    name: 'Custom Playwright Script',
    description: 'Run a custom Playwright browser automation spec.',
    tags: ['browser', 'playwright', 'automation']
  },
  inbox_scan: {
    name: 'Inbox Scan',
    description: 'Scan Instagram DM inbox for replies from outreach leads.',
    tags: ['instagram', 'inbox', 'browser']
  },
  enrich_batch: {
    name: 'Lead Enrichment Batch',
    description: 'Enrich leads with email, phone, and social data.',
    tags: ['enrichment', 'leads']
  },
  clip_cutter: {
    name: 'AI Clip Cutter',
    description: 'Cut and score video clips from discover content. Requires Docker.',
    tags: ['video', 'docker', 'ai']
  },
  comms_sync: {
    name: 'Communications Sync',
    description: 'Sync iMessage, email, and social inboxes to lead records.',
    tags: ['comms', 'sync']
  }
}

function buildAgentCard (nodeName, nodeId) {
  const skills = []
  for (const [type, meta] of Object.entries(TASK_TYPE_META)) {
    skills.push({
      id: type.replace(/_/g, '-'),
      name: meta.name,
      description: meta.description,
      tags: meta.tags || [],
      examples: meta.examples || []
    })
  }

  return {
    name: `IRIS Hive — ${nodeName || 'Unknown'}`,
    description: 'Sovereign compute node. Browser automation, AI outreach, content discovery, lead enrichment.',
    version: require('../package.json').version,
    url: 'http://localhost:3200/a2a',
    capabilities: {
      streaming: true,
      pushNotifications: false
    },
    skills,
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json', 'text/plain']
  }
}

function makeId () {
  return require('crypto').randomUUID()
}

/**
 * IrisA2AExecutor — implements the A2A AgentExecutor interface.
 *
 * execute(requestContext, eventBus) is called by DefaultRequestHandler.
 * It publishes events to eventBus and calls eventBus.finished() when done.
 */
class IrisA2AExecutor {
  constructor (taskExecutor, cloudClient) {
    this.executor = taskExecutor
    this.cloud = cloudClient
    this._pendingResults = new Map()

    // Intercept cloud.submitResult to capture task outcomes for A2A
    if (this.cloud && this.cloud.submitResult) {
      const originalSubmitResult = this.cloud.submitResult.bind(this.cloud)
      this.cloud.submitResult = async (taskId, result) => {
        const pending = this._pendingResults.get(taskId)
        if (pending) {
          pending.resolve(result)
          this._pendingResults.delete(taskId)
        }
        return originalSubmitResult(taskId, result)
      }
    }
  }

  _inferTaskType (prompt) {
    const lower = (prompt || '').toLowerCase()
    if (lower.includes('som') || lower.includes('outreach') || lower.includes('dm')) return 'som_batch'
    if (lower.includes('discover') || lower.includes('yt-feed') || lower.includes('youtube')) return 'discover'
    if (lower.includes('inbox')) return 'inbox_scan'
    if (lower.includes('enrich')) return 'enrich_batch'
    if (lower.includes('clip') || lower.includes('cut')) return 'clip_cutter'
    if (lower.includes('comms') || lower.includes('sync')) return 'comms_sync'
    return 'message'
  }

  /**
   * A2A execute — called by DefaultRequestHandler.
   * @param {object} rc — RequestContext with .taskId, .contextId, .userMessage
   * @param {object} eventBus — publish Task/status-update/artifact events, call .finished()
   */
  async execute (rc, eventBus) {
    const message = rc.userMessage || rc.message || {}
    const parts = message.parts || []
    const prompt = parts.map(p => p.text || '').join(' ').trim()

    const skillId = rc.metadata?.skill_id || this._inferTaskType(prompt)
    const taskType = skillId.replace(/-/g, '_')
    const taskId = rc.taskId || makeId()
    const contextId = rc.contextId || null

    // Publish "working" task
    eventBus.publish({
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state: 'working',
        message: {
          kind: 'message', messageId: makeId(), role: 'agent',
          parts: [{ kind: 'text', text: `Dispatching ${skillId} task...` }],
          taskId, contextId
        },
        timestamp: new Date().toISOString()
      }
    })

    // Create a promise that resolves when cloud.submitResult() fires
    const resultPromise = new Promise((resolve) => {
      this._pendingResults.set(taskId, { resolve })
      setTimeout(() => {
        if (this._pendingResults.has(taskId)) {
          this._pendingResults.delete(taskId)
          resolve({ status: 'failed', error: 'A2A task timeout', output: '' })
        }
      }, 630000)
    })

    // Build IRIS task and fire-and-forget to existing executor
    const irisTask = {
      id: taskId,
      type: taskType,
      prompt,
      title: `A2A: ${skillId}`,
      runtime: 'iris_agent',
      timeout_seconds: 600,
      config: { env_vars: {} },
      _source: 'a2a'
    }

    this.executor.execute(irisTask).catch(err => {
      const pending = this._pendingResults.get(taskId)
      if (pending) {
        pending.resolve({ status: 'failed', error: err.message, output: '' })
        this._pendingResults.delete(taskId)
      }
    })

    // Wait for completion
    const result = await resultPromise
    const isSuccess = result.status === 'completed' || result.status === 'success'

    // Publish final task with artifacts and terminal status
    eventBus.publish({
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state: isSuccess ? 'completed' : 'failed',
        message: {
          kind: 'message', messageId: makeId(), role: 'agent',
          parts: [{ kind: 'text', text: isSuccess ? (result.output || 'Task completed').slice(-500) : (result.error || 'Task failed') }],
          taskId, contextId
        },
        timestamp: new Date().toISOString()
      },
      artifacts: [{
        artifactId: makeId(),
        name: 'result.json',
        parts: [{ kind: 'text', text: JSON.stringify(result, null, 2) }]
      }]
    })

    eventBus.finished()
  }
}

module.exports = { IrisA2AExecutor, buildAgentCard, TASK_TYPE_META }
