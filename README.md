# dsh-plugins

Community plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

## Plugins

| Plugin | Description | Status |
|--------|-------------|--------|
| `file-watcher` | Watches workspace files for external changes and notifies the agent | WIP |

## Usage

These plugins are designed to run inside the DeepSeek Harness workspace. To use them:

1. Clone this repo into your harness `packages/` directory (or symlink it):

```sh
cd deepseek-harness
git clone https://github.com/wryyyds7/dsh-plugins.git packages/dsh-plugins
```

2. Add the plugin packages to `pnpm-workspace.yaml` if needed.

3. Install dependencies:

```sh
pnpm install
```

4. Reference the plugin in your harness config (e.g. `cordis.yml`):

```yaml
plugins:
  file-watcher:
    paths:
      - src
```

## License

MIT