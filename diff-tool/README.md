# dsh-diff-tool

Registers a `diff` tool that returns file or git-commit differences for efficient code review.

注册 `diff` 工具，返回文件或 git commit 之间的差异，用于高效代码审查。

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `maxLines` | `500` | Maximum diff lines to return |
| `contextLines` | `3` | Context lines around each hunk |

## Usage

The agent can call the `diff` tool with two modes:

### File comparison
```json
{ "mode": "files", "a": "/path/to/file1.ts", "b": "/path/to/file2.ts" }
```

### Git commit comparison
```json
{ "mode": "git", "a": "HEAD~1", "b": "HEAD", "path": "src/" }
```

The `path` parameter is optional for git mode — filters changes to a specific directory.
