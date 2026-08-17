# dsh-plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

个人开发的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件集合。

## Plugins / 插件列表

| Plugin | Description (EN) | 描述 (中文) | Status |
|--------|------------------|-------------|--------|
| `file-watcher` | Watches workspace files for external changes and notifies the agent via inbox injection | 监听工作区文件的外部变更，通过 inbox 注入通知 agent | Done |
| `diff-tool` | Registers a `diff` tool that returns file or git-commit differences for efficient code review | 注册 `diff` 工具，返回文件或 git commit 之间的差异，用于高效代码审查 | Done |

## Usage / 使用方法

These plugins are designed to run inside the DeepSeek Harness workspace. To use them:

这些插件需要在 DeepSeek Harness workspace 内运行。使用步骤：

1. Clone this repo into your harness `packages/` directory (or symlink it):

将本仓库克隆到 harness 的 `packages/` 目录下（或建立符号链接）：

```sh
cd deepseek-harness
git clone https://github.com/wryyyds7/dsh-plugins.git packages/dsh-plugins
```

2. Add the plugin packages to `pnpm-workspace.yaml` if needed.

如有需要，将插件包添加到 `pnpm-workspace.yaml`。

3. Install dependencies / 安装依赖：

```sh
pnpm install
```

4. Reference the plugin in your harness config (e.g. `cordis.yml`):

在 harness 配置文件中引用插件（如 `cordis.yml`）：

```yaml
plugins:
  file-watcher:
    paths:
      - src
```

## License

MIT
