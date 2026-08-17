import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as FileWatcher from '@deepseek-ai/dsh-file-watcher/src/index.ts'
import type { Config } from '@deepseek-ai/dsh-file-watcher/src/index.ts'
import { FileWatcher as FileWatcherClass } from '@deepseek-ai/dsh-file-watcher/src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the file-watcher plugin: config validation, ignore
 * patterns, debounce coalescing, notice format, and pre-step injection.
 */

let tempDir: string

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-file-watcher-'))
}

/** Boot the core spine + the file-watcher; caller registers adapters. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(FileWatcher, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const d = ctx.on('agent/status', ({ agent: s, status: st }) => {
      if (s === agent && st === 'idle') { d(); resolve() }
    })
  })
}

/** Every file-watcher-injected user message in the agent's log. */
function watcherNotices(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> =>
      e.type === 'user/message'
      && e.data.source.kind === 'plugin'
      && (e.data.source as { plugin?: string }).plugin === 'file-watcher',
    )
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

describe('config validation', () => {
  it('rejects negative debounceMs', () => {
    expect(() => new FileWatcherClass({ paths: ['.'], ignore: [], debounceMs: -1, maxFilesPerNotice: 20, pollIntervalMs: 2000 } as Config))
      .toThrow('debounceMs')
  })

  it('rejects zero maxFilesPerNotice', () => {
    expect(() => new FileWatcherClass({ paths: ['.'], ignore: [], debounceMs: 300, maxFilesPerNotice: 0, pollIntervalMs: 2000 } as Config))
      .toThrow('maxFilesPerNotice')
  })

  it('rejects pollIntervalMs below 100', () => {
    expect(() => new FileWatcherClass({ paths: ['.'], ignore: [], debounceMs: 300, maxFilesPerNotice: 20, pollIntervalMs: 50 } as Config))
      .toThrow('pollIntervalMs')
  })

  it('accepts valid config', () => {
    expect(() => new FileWatcherClass({ paths: ['.'], ignore: ['node_modules'], debounceMs: 100, maxFilesPerNotice: 5, pollIntervalMs: 500 } as Config))
      .not.toThrow()
  })
})

describe('ignore patterns', () => {
  beforeEach(async () => { tempDir = await makeTempDir() })
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }) })

  it('ignores node_modules and *.log files', async () => {
    await mkdir(join(tempDir, 'node_modules'), { recursive: true })
    const ctx = await harness({ paths: ['.'], ignore: ['node_modules', '*.log'], debounceMs: 50 })
    const adapter = new MockAdapter([
      textResponse('done'),
      textResponse('done2'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' }, { cwd: tempDir })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Write files — one in node_modules, one .log, one normal
    await writeFile(join(tempDir, 'node_modules', 'pkg.js'), 'test')
    await writeFile(join(tempDir, 'app.log'), 'log content')
    await writeFile(join(tempDir, 'src.ts'), 'code')

    // Wait for debounce + steer wake + step completion
    await waitForIdle(ctx, agent)
    await new Promise(r => setTimeout(r, 100))

    const found = watcherNotices(agent)
    expect(found.length).toBe(1)
    expect(found[0]!.text).toContain('src.ts')
    expect(found[0]!.text).not.toContain('node_modules')
    expect(found[0]!.text).not.toContain('app.log')
  })
})

describe('debounce coalescing', () => {
  beforeEach(async () => { tempDir = await makeTempDir() })
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }) })

  it('coalesces multiple rapid changes into one notice', async () => {
    const ctx = await harness({ paths: ['.'], ignore: [], debounceMs: 100 })
    const adapter = new MockAdapter([
      textResponse('done'),
      textResponse('done2'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' }, { cwd: tempDir })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Write 3 files rapidly
    await writeFile(join(tempDir, 'a.ts'), 'a')
    await writeFile(join(tempDir, 'b.ts'), 'b')
    await writeFile(join(tempDir, 'c.ts'), 'c')

    // Wait for debounce (100ms) + steer wake + step completion
    await waitForIdle(ctx, agent)
    await new Promise(r => setTimeout(r, 100))

    const found = watcherNotices(agent)
    expect(found.length).toBe(1)
    expect(found[0]!.text).toContain('a.ts')
    expect(found[0]!.text).toContain('b.ts')
    expect(found[0]!.text).toContain('c.ts')
  })
})

describe('notice format', () => {
  beforeEach(async () => { tempDir = await makeTempDir() })
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }) })

  it('truncates when exceeding maxFilesPerNotice', async () => {
    const ctx = await harness({ paths: ['.'], ignore: [], debounceMs: 50, maxFilesPerNotice: 2 })
    const adapter = new MockAdapter([
      textResponse('done'),
      textResponse('done2'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' }, { cwd: tempDir })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Write 4 files
    await writeFile(join(tempDir, 'a.ts'), 'a')
    await writeFile(join(tempDir, 'b.ts'), 'b')
    await writeFile(join(tempDir, 'c.ts'), 'c')
    await writeFile(join(tempDir, 'd.ts'), 'd')

    await waitForIdle(ctx, agent)
    await new Promise(r => setTimeout(r, 100))

    const found = watcherNotices(agent)
    expect(found.length).toBe(1)
    expect(found[0]!.text).toContain('and 2 more')
  })

  it('stamps plugin source on notices', async () => {
    const ctx = await harness({ paths: ['.'], ignore: [], debounceMs: 50 })
    const adapter = new MockAdapter([
      textResponse('done'),
      textResponse('done2'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' }, { cwd: tempDir })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    await writeFile(join(tempDir, 'hello.ts'), 'code')
    await waitForIdle(ctx, agent)
    await new Promise(r => setTimeout(r, 100))

    const found = watcherNotices(agent)
    expect(found.length).toBe(1)
    expect(found[0]!.source).toMatchObject({
      kind: 'plugin',
      plugin: 'file-watcher',
    })
  })
})

describe('buildNotice (unit)', () => {
  it('builds a notice with correct text', () => {
    const watcher = new FileWatcherClass({ paths: ['.'], ignore: [], debounceMs: 300, maxFilesPerNotice: 20, pollIntervalMs: 2000 } as Config)
    const notice = watcher.buildNotice([
      { relativePath: 'src/a.ts', eventType: 'change' },
      { relativePath: 'src/b.ts', eventType: 'rename' },
    ])
    expect(notice.content).toHaveLength(1)
    expect(notice.content[0]!.type).toBe('text')
    const text = (notice.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('src/a.ts')
    expect(text).toContain('src/b.ts')
    expect(text).toContain('(change)')
    expect(text).toContain('(rename)')
  })

  it('truncates at maxFilesPerNotice', () => {
    const watcher = new FileWatcherClass({ paths: ['.'], ignore: [], debounceMs: 300, maxFilesPerNotice: 3, pollIntervalMs: 2000 } as Config)
    const changes = Array.from({ length: 5 }, (_, i) => ({ relativePath: `file${i}.ts`, eventType: 'change' }))
    const notice = watcher.buildNotice(changes)
    const text = (notice.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('file0.ts')
    expect(text).toContain('file1.ts')
    expect(text).toContain('file2.ts')
    expect(text).not.toContain('file3.ts')
    expect(text).toContain('and 2 more')
  })
})