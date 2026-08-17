/**
 * File-change watcher plugin. Monitors workspace directories for external file
 * changes and injects advisory notifications into the agent's next-step inbox
 * so the model knows its working files were modified outside its own tool calls.
 *
 * The watcher uses Node's `fs.watch` with recursive support on macOS/Windows.
 * On Linux (where recursive `fs.watch` is unsupported) it falls back to a
 * directory-walk polling approach at a configurable interval.
 *
 * @module @deepseek-ai/dsh-file-watcher
 */

import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'file-watcher'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** Plugin configuration validated by schemastery. */
export interface Config {
  /** Directories to watch (relative to session cwd or absolute). Defaults to `['.']`. */
  paths?: string[]
  /** Glob-like ignore patterns using `*` wildcard (matched against relative paths). Defaults to `['node_modules', '.git', 'dist', 'lib']`. */
  ignore?: string[]
  /** Debounce window in ms to coalesce rapid bursts from one save. Defaults to 300. */
  debounceMs?: number
  /** Maximum number of changed files to report in one notification. Defaults to 20. */
  maxFilesPerNotice?: number
  /** Polling interval in ms for Linux fallback. Defaults to 2000. */
  pollIntervalMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  paths: z.array(z.string()).default(['.']),
  ignore: z.array(z.string()).default(['node_modules', '.git', 'dist', 'lib']),
  debounceMs: z.number().default(300),
  maxFilesPerNotice: z.number().default(20),
  pollIntervalMs: z.number().default(2000),
})

/** The `{kind:'plugin'}` source stamped on every notification this plugin injects. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'file-watcher' }

/** One pending file change tracked between debounce window and notification flush. */
interface FileChange {
  /** Relative path from the watched root. */
  relativePath: string
  /** Best-effort event type from `fs.watch`. */
  eventType: string
}

/** Compile one `*`-wildcard pattern to an anchored RegExp. */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Check whether a relative path matches any ignore pattern.  Patterns are
 * tested against each path segment as well as the full path, so `node_modules`
 * ignores the directory and everything inside it.
 */
function isIgnored(relativePath: string, patterns: RegExp[]): boolean {
  const segments = relativePath.split(sep)
  for (const pattern of patterns) {
    if (pattern.test(relativePath)) return true
    for (const segment of segments) {
      if (pattern.test(segment)) return true
    }
  }
  return false
}

/** Recursively walk a directory and collect subdirectory paths for Linux polling. */
async function collectDirs(root: string, ignorePatterns: RegExp[], base: string = root): Promise<string[]> {
  const dirs: string[] = [base]
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return dirs
  }
  for (const entry of entries) {
    const fullPath = join(base, entry)
    const rel = relative(root, fullPath)
    if (isIgnored(rel, ignorePatterns)) continue
    try {
      const s = await stat(fullPath)
      if (s.isDirectory()) {
        dirs.push(...await collectDirs(root, ignorePatterns, fullPath))
      }
    } catch {
      // stat failed — skip
    }
  }
  return dirs
}

/**
 * The file watcher service: manages OS-level watchers per agent session,
 * debounces change bursts, and injects advisory messages into the agent inbox.
 */
export class FileWatcher {
  private readonly watchers = new Map<Agent, FSWatcher[]>()
  private readonly pending = new Map<Agent, Map<string, FileChange>>()
  private readonly timers = new Map<Agent, ReturnType<typeof setTimeout>>()
  private readonly ignorePatterns: RegExp[]
  private readonly watchRoots: string[]
  private readonly debounceMs: number
  private readonly maxFilesPerNotice: number
  private readonly pollIntervalMs: number

  constructor(config: Config) {
    this.ignorePatterns = (config.ignore as string[]).map(wildcardToRegExp)
    this.watchRoots = config.paths as string[]
    this.debounceMs = config.debounceMs as number
    this.maxFilesPerNotice = config.maxFilesPerNotice as number
    this.pollIntervalMs = config.pollIntervalMs as number
    if (!Number.isInteger(this.debounceMs) || this.debounceMs < 0) {
      throw new Error(`file-watcher: invalid debounceMs ${this.debounceMs} — must be a non-negative integer`)
    }
    if (!Number.isInteger(this.maxFilesPerNotice) || this.maxFilesPerNotice < 1) {
      throw new Error(`file-watcher: invalid maxFilesPerNotice ${this.maxFilesPerNotice} — must be an integer >= 1`)
    }
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 100) {
      throw new Error(`file-watcher: invalid pollIntervalMs ${this.pollIntervalMs} — must be an integer >= 100`)
    }
  }

  /**
   * Start watching for an agent's session cwd.  Safe to call multiple times:
   * re-starting disposes the previous watchers first.
   */
  start(agent: Agent): void {
    this.stop(agent)
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const resolvedRoots = this.watchRoots.map(r => join(cwd, r))
    const watchers: FSWatcher[] = []
    for (const root of resolvedRoots) {
      try {
        const w = watch(root, { recursive: true }, (eventType, filename) => {
          if (filename === null) return
          const rel = relative(cwd, join(root, filename))
          if (isIgnored(rel, this.ignorePatterns)) return
          this.recordChange(agent, rel, eventType)
        })
        watchers.push(w)
      } catch {
        // recursive watch not supported (Linux) — fall back to polling
        void this.startPolling(agent, root, cwd, watchers)
      }
    }
    if (watchers.length > 0) {
      this.watchers.set(agent, watchers)
    }
  }

  /** Linux fallback: poll subdirectories individually. */
  private async startPolling(agent: Agent, root: string, cwd: string, watchers: FSWatcher[]): Promise<void> {
    const dirs = await collectDirs(root, this.ignorePatterns)
    for (const dir of dirs) {
      try {
        const w = watch(dir, (eventType, filename) => {
          if (filename === null) return
          const rel = relative(cwd, join(dir, filename))
          if (isIgnored(rel, this.ignorePatterns)) return
          this.recordChange(agent, rel, eventType)
        })
        watchers.push(w)
      } catch {
        // directory may have been removed
      }
    }
    if (watchers.length > 0) {
      this.watchers.set(agent, watchers)
    }
  }

  /** Record one file change and arm the debounce timer. */
  private recordChange(agent: Agent, relativePath: string, eventType: string): void {
    let pending = this.pending.get(agent)
    if (pending === undefined) {
      pending = new Map()
      this.pending.set(agent, pending)
    }
    pending.set(relativePath, { relativePath, eventType })
    const existing = this.timers.get(agent)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(agent)
      this.flush(agent)
    }, this.debounceMs)
    this.timers.set(agent, timer)
  }

  /** Flush pending changes as an advisory message into the agent's next-step inbox. */
  private flush(agent: Agent): void {
    const pending = this.pending.get(agent)
    if (pending === undefined || pending.size === 0) return
    this.pending.delete(agent)
    const changes = [...pending.values()]
    const notice = this.buildNotice(changes)
    // `steer` wakes an idle driver and queues for the nearest step boundary;
    // a running driver claims it at its next step. Either way the model sees
    // the notice as next-step context, not a full new turn.
    agent.steer(notice)
  }

  /**
   * Build a {@link UserMessage} from a list of file changes. Exposed so the
   * pre-step hook can build the same notice format synchronously.
   */
  buildNotice(changes: FileChange[]): UserMessage {
    const total = changes.length
    const reported = changes.slice(0, this.maxFilesPerNotice)
    const omitted = total - reported.length
    const lines = reported.map(c => `  - ${c.relativePath} (${c.eventType})`)
    if (omitted > 0) lines.push(`  ... and ${omitted} more`)
    const text = `External file changes detected since the last step:\n${lines.join('\n')}\n\nThese files were modified outside your tool calls. Review the changes before proceeding.`
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${total} file change(s)` } as MessageSource,
    })
  }

  /**
   * Drain and return all pending changes for an agent. Used by the pre-step
   * hook to fold changes into the step's inbox; draining prevents the
   * debounce timer from re-injecting the same changes.
   */
  getPending(agent: Agent): FileChange[] {
    const pending = this.pending.get(agent)
    if (pending === undefined || pending.size === 0) return []
    this.pending.delete(agent)
    // Cancel any armed debounce timer — the pre-step hook consumed the batch.
    const timer = this.timers.get(agent)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(agent)
    }
    return [...pending.values()]
  }

  /** Stop watching and clean up all resources for one agent. */
  stop(agent: Agent): void {
    const watchers = this.watchers.get(agent)
    if (watchers !== undefined) {
      for (const w of watchers) w.close()
      this.watchers.delete(agent)
    }
    const timer = this.timers.get(agent)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(agent)
    }
    this.pending.delete(agent)
  }

  /** Stop all watchers and clean up everything. */
  dispose(): void {
    for (const [agent] of this.watchers) this.stop(agent)
  }
}

/**
 * Install the file-watcher plugin.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const watcher = new FileWatcher(config)

  // Start watching when an agent is created.
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    watcher.start(agent)
  })

  // Flush pending changes into the next-step inbox before each step begins,
  // so the model sees them even if the debounce timer hasn't fired yet.
  ctx.on('agent/pre-step', (
    { agent, messages }: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const pending = watcher.getPending(agent)
    if (pending.length === 0) return next()
    const notice = watcher.buildNotice(pending)
    return next().then((decision: PreStepDecision) => {
      if (decision.kind === 'enter') {
        return { ...decision, messages: [...decision.messages, notice] }
      }
      return decision
    })
  })

  // Clean up on context disposal.
  ctx.effect(() => () => watcher.dispose(), 'file-watcher.dispose')
}