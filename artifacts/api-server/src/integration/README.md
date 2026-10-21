# integration

Integration tests against a real PostgreSQL. They connect as the application role (`bhi_app`), never a superuser, and are skipped when `TEST_DATABASE_URL` is unset. Run with `pnpm --filter @workspace/api-server test:integration`.
