# `@samchon/graph` Language Server Experiments

This workspace runs real LSP smoke experiments outside the coverage-gated test suite.

Each language job installs the actual language server, including any pinned producer fork declared by its catalog row, clones a representative public project, builds a graph in `mode: "lsp"`, and fails if the result loses its strict provenance or produces no language symbols.

Use the workflow in `.github/workflows/experiment.yml` for the full matrix.

```bash
pnpm --filter @samchon/graph-experiment list
pnpm --filter @samchon/graph-experiment run setup -- --language typescript
pnpm --filter @samchon/graph-experiment start -- --language typescript
```
