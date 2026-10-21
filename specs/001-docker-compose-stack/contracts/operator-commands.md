# Contract: Operator Command Surface

**Date**: 2026-08-11 | **Plan**: [../plan.md](../plan.md)

The interface this feature exposes to a developer. Every command runs from the repository root. This
contract is what [quickstart.md](../quickstart.md) validates and what `deploy/LOCAL-DEV.md` must document.

## Commands

| Intent | Command | Exit 0 means | FR |
|---|---|---|---|
| Start, building if needed | `docker compose up -d --build` | All services reached their readiness condition | FR-003 |
| Start, no rebuild | `docker compose up -d` | Same, using existing images | FR-003 |
| Follow all logs | `docker compose logs -f` | — (streams until interrupted) | FR-014, FR-015 |
| Follow one service | `docker compose logs -f api` | — | FR-015 |
| Show service state | `docker compose ps` | Table printed | FR-014 |
| Stop, **keep data** | `docker compose down` | Containers and network removed; volume retained | FR-003, FR-004 |
| **Reset — destroys the database** | `docker compose down -v` | Volume removed | FR-003 |
| Rebuild after a source change | `docker compose up -d --build api web` | Changed services rebuilt and restarted | FR-041 |
| Database shell | `docker compose exec db psql -U bhi_user -d bhi_portal` | Interactive prompt | — |
| Re-run migrations only | `docker compose run --rm migrate` | Every migration applied | FR-009 |

## The destructive command

`down` and `down -v` differ by two characters and by everything else. Documentation must:

- State the difference wherever either appears
- Never show `-v` in a routine step
- Present the reset case as its own named procedure, not as a variation on stopping

This is the only command in the surface that destroys anything.

## Guarantees

### Startup

- `up` is idempotent. Running it against a running stack is a no-op for unchanged services.
- `up` returns only once every readiness condition is met — not once containers are created.
- Failure names the responsible service and the reason (FR-014).

### Failure messages

Each of these must be diagnosable from command output alone, without reading source (SC-009):

| Condition | Must convey |
|---|---|
| Host port already in use | Which port, and the variable that changes it |
| `.env` missing | That it is missing, and the copy command that creates it |
| Required value missing from `.env` | Which variable (FR-023) |
| Database unreachable | That it is the database, distinguished from a dead API |
| Migration failed | Which file, and the database error |
| Schema out of date | The existing `SCHEMA_OUT_OF_DATE` error code, unchanged |
| Build failed | The compiler's own message, with the file |

### Logs

- Every line attributed to its service (FR-015).
- No personal data, verification code, card payload, token or secret (FR-028).
- nginx uses the existing `bhi_portal` format, carrying `$request_id` so one reference correlates the
  front-door line with the API line (FR-044).

### Data

- `down` then `up` preserves 100% of records (SC-005).
- Image rebuild preserves data — images carry none.
- Only `down -v` destroys.

## Non-guarantees

Stated so they are not assumed:

- **No hot reload.** A source change requires the rebuild command. The spec asks for a short cycle
  (SC-013, under 3 minutes), not a live one.
- **No host-side database access by default.** The database port is unpublished. Use `exec`, or enable the
  documented override.
- **No production use.** FR-033 — developer machines only.
- **No automatic migration rollback.** A failed migration stops the start; recovery is manual, or
  `down -v` on a throwaway database.
