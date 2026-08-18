# Changelog

## 0.1.0 (2026-08-17)

### Added
- **file-watcher**: Watches workspace files for external changes and notifies the agent via inbox injection. Uses `fs.watch` with recursive support (Linux polling fallback), configurable ignore patterns, debounce window, and max files per notice.
- **diff-tool**: Registers a `diff` tool supporting file-to-file and git commit comparison with unified diff output, configurable context lines and truncation.
- Bilingual (EN/CN) README with plugin table.
- MIT LICENSE.
- CONTRIBUTING guide.
- `dsh.bundle` manifest for `dsh plugin add` installability.
- `pnpm-workspace.yaml` for monorepo management.
