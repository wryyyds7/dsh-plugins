# Contributing

## Adding a new plugin

1. Create a new directory: `<plugin-name>/`
2. Add `package.json` with `@deepseek-ai/dsh-<plugin-name>` as the name
3. Implement the plugin in `src/index.ts`
4. Add `src/invariant.ts` (use the no-op template if no runtime invariants)
5. Write tests in `tests/<plugin-name>.spec.ts`
6. Add `<plugin-name>/README.md` with bilingual description
7. Add `<plugin-name>/.gitignore` with `node_modules/`
8. Update root `README.md` plugin table
9. Update `cordis.patch.yml` to declare the new plugin
10. Run tests inside the harness workspace before committing

## Testing

Plugins must be tested inside the DeepSeek Harness workspace. Copy or symlink
the plugin directory into `packages/community/<plugin-name>/` and run:

```sh
npx vitest run packages/community/<plugin-name>/tests/ --config vitest.config.ts
```

All tests must pass before committing.
