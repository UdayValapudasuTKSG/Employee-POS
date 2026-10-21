# lib/db/src/schema/bhi

Drizzle definitions of the 11 BHI Enrollment Database tables the application uses, shared by every company and guarded by row-level security. They live in schema `bhi` in `deploy/db/schema.sql`, beside the portal's own tables (defined one level up, in `lib/db/src/schema/`). Contract: `specs/002-per-company-schema/contracts/bhi-schema.sql`.
