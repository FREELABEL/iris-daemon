const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { WorkspaceManager } = require('../daemon/workspace-manager')

describe('WorkspaceManager', () => {
  let tmpDir
  let manager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-wm-test-'))
    manager = new WorkspaceManager(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── create() ────────────────────────────────────────────────

  describe('create()', () => {
    it('creates task directory with project and .output subdirs', () => {
      const result = manager.create('task-001', { type: 'test', title: 'Test task' })

      assert.ok(fs.existsSync(result.dir))
      assert.ok(fs.existsSync(result.projectDir))
      assert.ok(fs.existsSync(result.outputDir))
      assert.equal(result.projectDir, path.join(result.dir, 'project'))
      assert.equal(result.outputDir, path.join(result.dir, '.output'))
    })

    it('writes .task.json with task definition', () => {
      const task = { type: 'discover', title: 'YouTube import', priority: 5 }
      const result = manager.create('task-002', task)

      const taskFile = path.join(result.dir, '.task.json')
      assert.ok(fs.existsSync(taskFile))

      const content = JSON.parse(fs.readFileSync(taskFile, 'utf-8'))
      assert.deepEqual(content, task)
    })
  })

  // ─── collectOutputFiles() ────────────────────────────────────

  describe('collectOutputFiles()', () => {
    it('returns files from project directory', () => {
      const { projectDir } = manager.create('task-003', { type: 'test' })

      // Create some files
      fs.writeFileSync(path.join(projectDir, 'index.js'), 'console.log("hello")')
      fs.writeFileSync(path.join(projectDir, 'README.md'), '# Test')

      const files = manager.collectOutputFiles('task-003')

      assert.ok(files.length >= 2)
      const names = files.map(f => f.name)
      assert.ok(names.includes('index.js'))
      assert.ok(names.includes('README.md'))
    })

    it('skips files > 1MB', () => {
      const { projectDir } = manager.create('task-004', { type: 'test' })

      // Create a file > 1MB
      const bigContent = 'x'.repeat(1024 * 1024 + 1)
      fs.writeFileSync(path.join(projectDir, 'big.bin'), bigContent)
      fs.writeFileSync(path.join(projectDir, 'small.txt'), 'small')

      const files = manager.collectOutputFiles('task-004')
      const names = files.map(f => f.name)

      assert.ok(!names.includes('big.bin'), 'Should skip files > 1MB')
      assert.ok(names.includes('small.txt'))
    })

    it('includes content for files < 100KB', () => {
      const { projectDir } = manager.create('task-005', { type: 'test' })
      fs.writeFileSync(path.join(projectDir, 'app.js'), 'const x = 1')

      const files = manager.collectOutputFiles('task-005')
      const appFile = files.find(f => f.name === 'app.js')

      assert.ok(appFile)
      assert.equal(appFile.content, 'const x = 1')
    })

    it('omits content for files between 100KB-1MB', () => {
      const { projectDir } = manager.create('task-006', { type: 'test' })

      // Create a file between 100KB and 1MB
      const mediumContent = 'y'.repeat(200 * 1024)
      fs.writeFileSync(path.join(projectDir, 'medium.dat'), mediumContent)

      const files = manager.collectOutputFiles('task-006')
      const medFile = files.find(f => f.name === 'medium.dat')

      assert.ok(medFile)
      assert.equal(medFile.content, '[file too large — content omitted]')
    })

    it('skips node_modules and .git directories', () => {
      const { projectDir } = manager.create('task-007', { type: 'test' })

      // Create files inside node_modules and .git
      fs.mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}')

      fs.mkdirSync(path.join(projectDir, '.git', 'objects'), { recursive: true })
      fs.writeFileSync(path.join(projectDir, '.git', 'config'), '[core]')

      // Also create a normal file
      fs.writeFileSync(path.join(projectDir, 'main.js'), 'console.log("main")')

      const files = manager.collectOutputFiles('task-007')
      const names = files.map(f => f.name)

      assert.ok(names.includes('main.js'), 'Should include normal files')
      assert.ok(!names.some(n => n.includes('node_modules')), 'Should skip node_modules')
      assert.ok(!names.some(n => n.includes('.git')), 'Should skip .git')
    })
  })

  // ─── cleanup() ───────────────────────────────────────────────

  describe('cleanup()', () => {
    it('removes the entire task directory', () => {
      const { dir, projectDir } = manager.create('task-008', { type: 'test' })
      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'data')

      assert.ok(fs.existsSync(dir))
      manager.cleanup('task-008')
      assert.ok(!fs.existsSync(dir))
    })
  })

  // ─── listActive() ────────────────────────────────────────────

  describe('listActive()', () => {
    it('returns task IDs that have .task.json', () => {
      manager.create('task-a', { type: 'test' })
      manager.create('task-b', { type: 'test' })

      // Create a bare directory without .task.json (orphan)
      fs.mkdirSync(path.join(tmpDir, 'tasks', 'orphan-dir'), { recursive: true })

      const active = manager.listActive()

      assert.ok(active.includes('task-a'))
      assert.ok(active.includes('task-b'))
      assert.ok(!active.includes('orphan-dir'), 'Bare directory without .task.json should be excluded')
    })
  })
})
