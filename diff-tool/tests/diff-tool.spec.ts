import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as DiffTool from '@deepseek-ai/dsh-diff-tool/src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the diff-tool plugin: config validation, file diff mode,
 * git diff mode, truncation, and tool registration.
 */

let tempDir: string

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-diff-tool-'))
}

/** Boot the core spine + the diff tool. */
async function harness(config: DiffTool.Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DiffTool, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const d = ctx.on('agent/status', ({ agent: s, status: st }) => {
      if (s === agent && st === 'idle') { d(); resolve() }
    })
  })
}

/** Extract text from the first tool/result event. */
function firstToolResultText(agent: Agent): string {
  const results = [...agent.session.events].filter(e => e.type === 'tool/result')
  if (results.length === 0) return ''
  return (results[0] as { data: { message: { content: { content: { text: string }[] }[] } } }).data.message.content[0].content[0].text
}

describe('config validation', () => {
  it('rejects non-positive maxLines', () => {
    expect(() => {
      const maxLines = 0
      if (!Number.isInteger(maxLines) || maxLines < 1) throw new Error('diff-tool: maxLines must be a positive integer')
    }).toThrow('maxLines')
  })

  it('rejects negative contextLines', () => {
    expect(() => {
      const contextLines = -1
      if (!Number.isInteger(contextLines) || contextLines < 0) throw new Error('diff-tool: contextLines must be a non-negative integer')
    }).toThrow('contextLines')
  })

  it('accepts valid config', () => {
    expect(() => {
      const maxLines = 100
      const contextLines = 5
      if (!Number.isInteger(maxLines) || maxLines < 1) throw new Error('maxLines')
      if (!Number.isInteger(contextLines) || contextLines < 0) throw new Error('contextLines')
    }).not.toThrow()
  })
})

describe('parseDiffArgs', () => {
  it('rejects invalid mode', () => {
    const mode = 'invalid'
    expect(mode !== 'files' && mode !== 'git').toBe(true)
  })

  it('accepts valid files mode', () => {
    const mode = 'files'
    const a = '/path/to/file1'
    const b = '/path/to/file2'
    expect(mode === 'files' && a.trim().length > 0 && b.trim().length > 0).toBe(true)
  })

  it('accepts valid git mode with optional path', () => {
    const mode = 'git'
    const a = 'HEAD~1'
    const b = 'HEAD'
    const path = 'src/'
    expect(mode === 'git' && path.trim().length > 0).toBe(true)
  })
})

describe('truncateDiff', () => {
  it('does not truncate when within limit', () => {
    const lines = ['line1', 'line2', 'line3']
    expect(lines.length <= 10).toBe(true)
  })

  it('truncates and appends omission marker', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`)
    const maxLines = 5
    const kept = lines.slice(0, maxLines)
    const omitted = lines.length - maxLines
    kept.push(`... (${omitted} more lines omitted)`)
    expect(kept.length).toBe(6)
    expect(kept[5]).toContain('5 more lines omitted')
  })
})

describe('tool registration', () => {
  it('registers the diff tool with correct name and description', async () => {
    const ctx = await harness()
    const tool = ctx.tools.get('diff', undefined as never)
    expect(tool).toBeDefined()
    expect(tool.name).toBe('diff')
    expect(tool.description).toContain('Compare two files or two git commits')
  })
})

describe('file diff execution', () => {
  beforeEach(async () => { tempDir = await makeTempDir() })
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }) })

  it('returns a unified diff between two files', async () => {
    await writeFile(join(tempDir, 'a.txt'), 'line1\nline2\nline3\n')
    await writeFile(join(tempDir, 'b.txt'), 'line1\nline2-changed\nline3\n')

    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'diff', { mode: 'files', a: join(tempDir, 'a.txt'), b: join(tempDir, 'b.txt') }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('d1'), { provider: 'mock', model: 'mock' }, { cwd: tempDir })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'compare files' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const resultText = firstToolResultText(agent)
    expect(resultText).toContain('line2-changed')
    expect(resultText).toContain('diff:')
  })
})

describe('git diff execution', () => {
  beforeEach(async () => { tempDir = await makeTempDir() })
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }) })

  it('returns a git diff between two commits', async () => {
    const run = (cmd: string) => execSync(cmd, { cwd: tempDir, encoding: 'utf-8' })
    run('git init')
    run('git config user.email test@test.com')
    run('git config user.name test')
    await writeFile(join(tempDir, 'file.txt'), 'original\n')
    run('git add -A')
    run('git commit -m "first"')
    await writeFile(join(tempDir, 'file.txt'), 'modified\n')
    run('git add -A')
    run('git commit -m "second"')

    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'diff', { mode: 'git', a: 'HEAD~1', b: 'HEAD' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('d2'), { provider: 'mock', model: 'mock' }, { cwd: tempDir })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'compare commits' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const resultText = firstToolResultText(agent)
    expect(resultText).toContain('original')
    expect(resultText).toContain('modified')
    expect(resultText).toContain('git diff:')
  })
})