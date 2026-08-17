/**
 * Diff tool plugin. Registers a `diff` tool that compares two files or two
 * git commits and returns a unified diff. The tool uses Node's
 * `child_process.execSync` directly, avoiding the need for a shell service
 * dependency and keeping the plugin self-contained.
 *
 * @module @deepseek-ai/dsh-diff-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { execSync } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'diff-tool'

/** Services required by the diff tool. */
export const inject = ['tools', 'systemPrompt']

/** Default maximum diff lines. */
export const DEFAULT_MAX_LINES = 500

/** Default context lines around each hunk. */
export const DEFAULT_CONTEXT_LINES = 3

/** Plugin config (all optional). */
export interface Config {
  /** Maximum number of diff lines to return. Defaults to 500. */
  maxLines?: number
  /** Number of context lines around each change. Defaults to 3. */
  contextLines?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxLines: z.number().step(1).min(1).default(DEFAULT_MAX_LINES),
  contextLines: z.number().step(1).min(0).default(DEFAULT_CONTEXT_LINES),
})

/** Validated diff arguments. */
interface DiffInput {
  /** Mode: 'files' for file-to-file, 'git' for git commit comparison. */
  mode: 'files' | 'git'
  /** For 'files' mode: first file path. For 'git' mode: the "from" ref. */
  a: string
  /** For 'files' mode: second file path. For 'git' mode: the "to" ref. */
  b: string
  /** Optional path filter for git mode. */
  path?: string
}

/** Validate and parse tool arguments. */
function parseDiffArgs(args: {
  mode?: string
  a?: string
  b?: string
  path?: string
}): DiffInput {
  const mode = args.mode
  if (mode !== 'files' && mode !== 'git') {
    throw new Error('mode must be "files" or "git"')
  }
  if (typeof args.a !== 'string' || args.a.trim().length === 0) {
    throw new Error('a must be a non-empty string')
  }
  if (typeof args.b !== 'string' || args.b.trim().length === 0) {
    throw new Error('b must be a non-empty string')
  }
  return {
    mode,
    a: args.a,
    b: args.b,
    ...args.path !== undefined && args.path.trim().length > 0 ? { path: args.path } : {},
  }
}

/** Truncate diff output if it exceeds the line limit. */
function truncateDiff(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  const kept = lines.slice(0, maxLines)
  const omitted = lines.length - maxLines
  kept.push(`... (${omitted} more lines omitted)`)
  return kept.join('\n')
}

/** Escape a string for safe use as a shell argument. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Install the diff tool.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxLines = config.maxLines ?? DEFAULT_MAX_LINES
  const contextLines = config.contextLines ?? DEFAULT_CONTEXT_LINES

  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error(`diff-tool: maxLines must be a positive integer`)
  }
  if (!Number.isInteger(contextLines) || contextLines < 0) {
    throw new Error(`diff-tool: contextLines must be a non-negative integer`)
  }

  ctx.systemPrompt.section({
    name: 'tool:diff',
    order: 110,
    text: 'Use the diff tool to compare two files or two git commits. Returns a unified diff with context lines. For file comparison, provide mode="files" with file paths. For git comparison, provide mode="git" with commit hashes, branch names, or tags.',
  })

  ctx.tools.register(defineTool({
    name: 'diff',
    description: 'Compare two files or two git commits and return a unified diff.',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        description: 'Comparison mode: "files" for file-to-file, "git" for git commit/branch comparison.',
      },
      a: {
        type: 'string',
        required: true,
        description: 'For "files" mode: the first file path. For "git" mode: the source ref (commit hash, branch name, or tag).',
      },
      b: {
        type: 'string',
        required: true,
        description: 'For "files" mode: the second file path. For "git" mode: the target ref (commit hash, branch name, or tag).',
      },
      path: {
        type: 'string',
        description: 'Optional path filter for "git" mode: only show changes under this path (e.g. "src/").',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          a: { type: 'string', required: true },
          b: { type: 'string', required: true },
          diff: { type: 'string', required: true },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const v = value as { mode: string; a: string; b: string; diff: string; truncated?: boolean }
        const header = v.mode === 'files'
          ? `diff: ${v.a} ↔ ${v.b}`
          : `git diff: ${v.a} → ${v.b}`
        return [{
          type: 'text',
          text: `${header}\n${v.diff}`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseDiffArgs(args)

      // Resolve cwd from the agent's session
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()

      let command: string
      if (input.mode === 'files') {
        command = `diff -U${contextLines} -- ${shellEscape(input.a)} ${shellEscape(input.b)} 2>&1 || true`
      } else {
        const pathFilter = input.path !== undefined ? ` -- ${shellEscape(input.path)}` : ''
        command = `git diff -U${contextLines} ${shellEscape(input.a)} ${shellEscape(input.b)}${pathFilter} 2>&1 || true`
      }

      let rawDiff: string
      try {
        rawDiff = execSync(command, { cwd, encoding: 'utf-8', timeout: 30_000, signal: exec.signal })
      } catch (err: unknown) {
        // execSync throws on non-zero exit even with `|| true` if signal fires
        if (exec.signal.aborted) throw err
        rawDiff = (err as { stdout?: string }).stdout ?? String(err)
      }

      const truncated = rawDiff.split('\n').length > maxLines
      const diffText = truncateDiff(rawDiff, maxLines)

      return {
        mode: input.mode,
        a: input.a,
        b: input.b,
        diff: diffText,
        ...truncated ? { truncated: true } : {},
      }
    },
  }))
}