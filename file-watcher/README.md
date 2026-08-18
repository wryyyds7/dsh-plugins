# dsh-file-watcher

Watches workspace files for external changes and notifies the agent via inbox injection.

监听工作区文件的外部变更，通过 inbox 注入通知 agent。

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `paths` | `['.']` | Directories to watch (relative to session cwd) |
| `ignore` | `['node_modules', '.git', 'dist', 'lib']` | Glob-like ignore patterns |
| `debounceMs` | `300` | Debounce window to coalesce rapid bursts |
| `maxFilesPerNotice` | `20` | Max files per notification before truncation |
| `pollIntervalMs` | `2000` | Polling interval for Linux fallback |

## How it works

1. Uses `fs.watch` with recursive support (macOS/Windows); Linux falls back to per-directory polling.
2. Debounces rapid bursts into a single notification.
3. Injects notifications via `agent.steer()` — wakes idle agents and queues for running agents.
4. `agent/pre-step` hook drains pending changes to avoid duplication.
