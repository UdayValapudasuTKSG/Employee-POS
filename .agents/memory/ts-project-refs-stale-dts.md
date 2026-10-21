---
name: Stale project-reference declarations
description: False "no exported member" errors from @workspace/* packages come from stale dist .d.ts
---
When `tsc -p` in an artifact reports missing exports from a `@workspace/*` lib that clearly exports them, the lib's `dist/*.d.ts` is stale (libs use composite/emitDeclarationOnly).
**Why:** typecheck resolves referenced projects via their emitted declarations, not source.
**How to apply:** run `npx tsc -b lib/<pkg>` from the repo root to rebuild declarations, then re-run the artifact typecheck.
