---
name: OpenAPI codegen quirks
description: Pitfalls when editing lib/api-spec/openapi.yaml and running orval codegen in this repo
---

- `format: email` in the spec makes orval emit `zod.email()`, which does not exist in the repo's zod v3 — codegen typecheck fails. Use `minLength` in the spec and validate email format server-side.
**Why:** hit during admin-user management work; orval 8 targets zod v4 helpers for string formats.
**How to apply:** after any spec change run `pnpm --filter @workspace/api-spec run codegen` (it typechecks libs) before touching server/client code.

- Seeded demo admin password is 9 chars ("Demo@2026"); any password policy with min length > 9 breaks demo accounts' self-service password change.
