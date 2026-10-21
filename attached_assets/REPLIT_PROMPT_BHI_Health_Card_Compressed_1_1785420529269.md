# Replit Build Prompt — BHI Health Insurance Digital Card (Web App)

> Paste this whole document into Replit's AI agent as one message.

---

## 1. ROLE & MISSION

You are a senior full-stack engineer. Build a **web application** (browser, desktop-first, responsive to 375px) called **BHI Health Card Portal**.

Employees retrieve and view a **digital health insurance card** in the browser after a one-time-code check. HR staff maintain the member records through an admin portal where **every capability is gated by role and company scope**.

| Surface | Who | Auth |
|---|---|---|
| Employee card lookup | any employee, no account | email/phone → 6-digit OTP → 15-min card session |
| Admin portal | HR / support staff | email + password → JWT carrying role + company scope |

**The core deliverable is the authorization layer.** OTP is deliberately simple plumbing. Build accordingly.

Work through the stages in §13 and stop for my `continue` after each.

---

## 2. LOCKED STACK — no substitutions

- **Backend:** Java 17, Spring Boot 3.2+ (Web, Security, Data JPA, Validation), Maven **with committed wrapper**, `jjwt` 0.12.x, `springdoc-openapi` for Swagger.
- **Database:** **H2 file mode by default** (`jdbc:h2:file:./data/bhicard;AUTO_SERVER=TRUE`) so nothing needs installing. PostgreSQL 16 as an optional profile. Schema via `ddl-auto=update` + a Java seeder — **do not add Flyway**.
- **Frontend:** React 18 + TypeScript + Vite, React Router v6, TanStack Query v5, Tailwind v3, Axios, react-hook-form + zod. **No component library** — hand-build components.
- **Tests:** JUnit 5 + Spring Boot Test. The RBAC suite in §11 is mandatory.

---

## 3. HARD CONSTRAINTS

**Must:** run with **only JDK 17 + Node 20 installed** — no Docker, no database server, no env vars, no cloud account · run identically in Replit · use **synthetic data generated in code** (never read a CSV, Excel, or uploaded file) · enforce all authorization **server-side** · **archive only, never hard delete** — no delete endpoint, no `repository.delete()`, no delete statement anywhere.

**Must not build:** native/hybrid mobile, React Native, Flutter · biometrics, device binding, attestation, cert pinning · wallet passes, QR codes, push notifications · any GCP/AWS/Azure/Firebase SDK · KMS, HSM, secrets vault · MFA beyond the single OTP · real SMS or email delivery · Docker as a requirement · real or realistic national ID numbers, phone numbers, or email domains.

Security is intentionally minimal: hashed passwords, hashed OTPs, a signed JWT, server-side authorization. Nothing more.

---

## 4. ROLES

| Role | Constant | Scope |
|---|---|---|
| Group HR Admin | `ROLE_HR_GROUP_ADMIN` | all companies, full rights |
| Company HR Admin | `ROLE_HR_ADMIN` | **one company only** |
| Support Agent | `ROLE_SUPPORT` | all companies, **masked**, read-only |
| Auditor | `ROLE_AUDITOR` | audit + verification history only |
| Employee | *(no role — `CARD_SESSION` scope)* | own card only |

---

## 5. AUTHORIZATION MATRIX — implement exactly

Define permissions as an enum. Roles map to permission sets. Controllers check **permissions, never role names**.

| Permission | GROUP_ADMIN | HR_ADMIN | SUPPORT | AUDITOR | EMPLOYEE |
|---|:--:|:--:|:--:|:--:|:--:|
| `MEMBER_READ_SCOPED` | ✓ | ✓ own company | ✓ masked | ✗ | ✗ |
| `MEMBER_READ_ALL` | ✓ | ✗ | ✓ masked | ✗ | ✗ |
| `MEMBER_UPDATE` | ✓ | ✓ own company | ✗ | ✗ | ✗ |
| `DEPENDENT_UPDATE` | ✓ | ✓ own company | ✗ | ✗ | ✗ |
| `MEMBER_ARCHIVE` | ✓ | ✓ own company | ✗ | ✗ | ✗ |
| `MEMBER_REACTIVATE` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `MEMBER_IMPORT` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `CONTACT_UNMASK` | ✓ | ✓ own company | ✗ | ✗ | ✗ |
| `AUDIT_READ` | ✓ | ✓ own company | ✗ | ✓ all | ✗ |
| `VERIFICATION_READ` | ✓ | ✓ own company | ✓ masked | ✓ masked | ✗ |
| `ADMIN_USER_READ` | ✓ | ✗ | ✗ | ✗ | ✗ |
| `CARD_READ_OWN` | ✗ | ✗ | ✗ | ✗ | ✓ |

The asymmetries are intentional and are the point of the exercise: HR_ADMIN can archive but not reactivate; SUPPORT sees widely but changes nothing; AUDITOR reads group-wide trails but cannot open a member record.

**Enforce in four layers:** frontend route guards (cosmetic only) → `@PreAuthorize` on **every** admin endpoint → a `ScopeResolver` that hands services `ALL` or a `companyCode` → repository queries that filter on that scope in the query itself.

**Behaviours:** deny by default (403) · cross-scope requests return **404, not 403**, so a scoped admin never learns the record exists · masking happens in the server-side response mapper, so raw contacts never leave the server · every denial writes an `ACCESS_DENIED` audit row · every mutation writes an audit row with actor, before, after, and a mandatory reason.

---

## 6. DATA MODEL

Nine JPA entities, UUID ids, all with `createdAt` / `updatedAt`.

- **Company** — code, name, active
- **EmployeeMember** — employeeNumber, firstName, lastName, dateOfBirth, identificationId, email?, phone?, company→FK, `employmentStatus` {ACTIVE, RESIGNED, TERMINATED, RETIRED}, `memberStatus` {ACTIVE, SUSPENDED, ARCHIVED}, archivedAt, archivedReason
- **PolicyMembership** — member→FK, policyholder, policyNumber, groupNumber, memberId, certificateNumber, planName, effectiveDate, expiryDate, insurerName
- **Dependent** — member→FK, firstName, lastName, `relationship` {SPOUSE, CHILD, OTHER}, dateOfBirth, `status` {ACTIVE, ARCHIVED}
- **VerificationSession** — lookupChannel, maskedDestination, otpHash, memberId, expiresAt, attempts, `status` {PENDING, VERIFIED, EXPIRED, LOCKED}
- **CardSession** — tokenHash, memberId, issuedAt, expiresAt, revoked
- **AdminUser** — email, displayName, passwordHash (BCrypt), role, companyScope (null = all), active
- **AuditLog** — actor, actorRole, action, entityType, entityId, beforeValue, afterValue, reason, sourceIp, timestamp. **Append-only.**
- **AppEventLog** — anonymizedKey, eventType, result, errorCode, latencyMs, timestamp

**Status rules:** card retrieval requires `employmentStatus = ACTIVE` **and** `memberStatus = ACTIVE`. Archived members stay fully visible to admin search and audit, and are invisible to employee lookup until reactivated.

---

## 7. SYNTHETIC DATA

`SyntheticDataSeeder` (`@Component`, runs on empty DB) using `new Random(42)` so runs are reproducible.

**Volumes:** 6 companies (`BF` Beharry Foods, `BA` Automotive, `BL` Logistics, `BR` Retail, `BM` Manufacturing, `BS` Services) · 120 members split 30/25/20/18/15/12 · ~300 dependents (0–4 each, weighted) · 1 policy each · 5 admin users · ~40 audit rows so the audit viewer isn't empty.

**Formats — keep everything obviously fake:** emails `first.last@bhi-demo.test` (reserved TLD) · phones `+592-555-0NNN` (reserved fictional block) · IDs `SYN-########` · `POL-2026-#####` · `GRP-<code>` · `MBR-######` · `CERT-######` · insurer `NALICO/NAFICO` · plan `Group Medical Plan 2026` · effective `2026-08-01`. Names assembled from fixed arrays; no recognisable public figures.

**Seed these edge cases — they are the test surface:** 5 members sharing one phone (family, drives disambiguation) · 8 with no email · 6 with no phone · 2 with neither (unreachable) · 4 archived · 3 `RESIGNED` but `memberStatus=ACTIVE` (leaver gap) · 2 expired policies · 3 with 4 dependents · 1 duplicate-email pair.

**Print to console on startup** — the five seeded logins (all password `Demo@2026`): `group.admin@` GROUP_ADMIN/all · `hr.foods@` HR_ADMIN/BF · `hr.auto@` HR_ADMIN/BA · `support@` SUPPORT/masked · `auditor@` AUDITOR (all `@bhi-demo.test`) — plus **three sample lookup identifiers** (one email, one phone, one shared-phone member) so I can test immediately.

---

## 8. FUNCTIONAL SCOPE

### Employee flow
`/` landing → `/lookup` (email or phone) → `/verify` (6-digit code) → `/confirm` (first name, masked identifier, company only) → `/card` → log out.

Rules: **uniform lookup response** — identical shape and message whether or not a match exists · nothing about the member returned before OTP verification · one identifier matching several members returns a disambiguation list of **non-identifying** options (`"J•••• D••••, born 19••-04"`) with opaque refs · card shows insurer, plan, policyholder, policy/group/member/certificate numbers, employee name, identification ID, effective date, dependents table, back-of-card notice · log out clears the token client-side **and** revokes the CardSession server-side.

### Admin portal routes
`/admin/login` · `/admin` dashboard · `/admin/members` search · `/admin/members/:id` detail · `/admin/members/:id/edit` · `/admin/import` · `/admin/audit` · `/admin/verifications` · `/admin/users` · `/admin/permissions`

Each route is visible only if the role holds the matching permission from §5. Notable behaviours: archive requires a reason; reactivate is visible only to GROUP_ADMIN; bulk import runs a dry-run preview with per-row `OK`/`WARN`/`ERROR` before a separate commit action; `/admin/permissions` renders the §5 matrix with the current user's row highlighted, so the RBAC work is demonstrable.

---

## 9. OTP + API

**OTP:** 6 digits from `SecureRandom` · SHA-256 hash stored, **plaintext never persisted or logged to a record** · 5-min TTL · 3 attempts then `LOCKED` · resend after 60s, max 3 · **delivery is console only** (`[OTP] destination=+592-555-0123 code=482913`) — add no provider · when `app.otp.dev-mode=true` (default) also return the code in the response and show a dismissible dev banner; set false in the `prod` profile · card token: opaque, 15-min TTL, single member, hashed, server-revocable.

**API** — base `/api/v1`, consistent envelope, errors as `{ "error": { "code", "message" } }`, no stack traces. Swagger at `/swagger-ui.html`.

```
Employee   POST /lookup · POST /lookup/select · POST /otp/verify
           GET  /card · POST /session/logout          (Bearer cardToken)

Admin      POST /admin/auth/login → { token, role, scope, permissions[] }
           GET  /admin/me · GET /admin/dashboard
           GET  /admin/members?q&company&status&page   (paged, scope-filtered)
           GET  /admin/members/{id}                    (404 if out of scope)
           PATCH /admin/members/{id}   { fields, reason }
           POST /admin/members/{id}/archive | /reactivate   { reason }
           POST /admin/import          { csvText, dryRun }
           GET  /admin/audit?entityId&actor&action&from&to
           GET  /admin/verifications   (masked)
           GET  /admin/users · GET /admin/permissions
```

---

## 10. LOCAL EXECUTION — most important requirement

I must clone the repo and be running in under two minutes with two commands. Prerequisites are **only** JDK 17+ and Node 20+ — no Maven install (wrapper committed), no database, no `.env`.

**Two terminals:**
```bash
cd backend && ./mvnw spring-boot:run      # → http://localhost:8080
cd frontend && npm install && npm run dev # → http://localhost:5173
```

**One command:** `make dev` runs both and streams both logs; Ctrl+C stops both. Provide `scripts/dev.sh` and `scripts/dev.bat` for anyone without `make`. Makefile targets: `install`, `dev`, `backend`, `frontend`, `test`, `build`, `run-prod`, `reset-db`, `clean`.

**Single-port mode** (also what Replit uses): `make build` runs the Vite build, copies `dist/` into the backend's `resources/static/`, and packages the JAR; `make run-prod` serves SPA + API together on `:8080`. Add a `SpaForwardingController` so unmatched non-`/api` paths forward to `index.html` and client routes survive a hard refresh.

**Config must work with zero overrides:** `server.port=${PORT:8080}`, H2 file datasource, `ddl-auto=update`, H2 console at `/h2-console`, `app.jwt.secret=${JWT_SECRET:local-dev-secret-min-32-chars}`, `app.otp.dev-mode=${OTP_DEV_MODE:true}`, CORS allowing `localhost:5173` and `localhost:8080`. Vite proxies `/api` → `:8080` so the frontend needs no base URL in dev.

**Optional Postgres:** `docker compose up -d`, then run with `-Dspring-boot.run.profiles=postgres`.

**Replit:** `.replit` with `run = "bash scripts/replit-start.sh"`, modules `java-17` + `nodejs-20`, port 8080 → 80; `replit.nix` with jdk17, nodejs_20, maven, gnumake. The start script installs deps if missing, builds the frontend, packages, and runs the JAR — single port, no CORS.

**README** must contain, paste-ready with no editing: prerequisites → two-terminal quick start → `make dev` → the seeded credentials table → the three sample lookup identifiers → where to find OTP codes in the console → single-port build → Postgres option → troubleshooting (port in use, npm install failure, `mvnw` permissions, resetting the DB) → project structure.

---

## 11. ACCEPTANCE CHECKLIST

Print this with results. Do not report complete until all pass.

**Local run** — fresh clone starts with no configuration · `make dev` starts and stops both cleanly · `make build && make run-prod` serves everything on `:8080` · hard-refresh of `/admin/members` in single-port mode doesn't 404 · `make reset-db` reseeds · Replit run button works.

**Data** — 6 / 120 / ~300 / 120 / 5 / ~40 as specified · two fresh runs produce identical data · all nine edge cases present and findable · no file is read anywhere · every identifier synthetic-prefixed, every email `.test`, every phone `555-01xx`.

**RBAC (critical)** — HR_ADMIN(BF) search returns only BF rows · HR_ADMIN(BF) requesting a BA member by id gets **404** · HR_ADMIN reactivate → 403 · SUPPORT PATCH → 403 · SUPPORT responses contain no raw contacts anywhere in the JSON · AUDITOR `GET /admin/members` → 403 but `/admin/audit` returns data · AUDITOR mutation → 403 · HR_ADMIN `/admin/users` → 403 · GROUP_ADMIN passes all · every denial writes `ACCESS_DENIED` · every admin endpoint has `@PreAuthorize` (state the count) · automated suite of **12 permissions × 4 admin roles = 48 assertions**, all green.

**Employee flow** — unknown and known identifiers return byte-identical shapes · no member data before verification · shared-phone family triggers non-identifying disambiguation · 3 wrong codes locks · OTP expires at 5 min · archived member blocked but visible in admin · `RESIGNED` blocked · card token expires at 15 min and log out revokes it · plaintext OTP in console only, in no persisted record.

**Integrity** — repo-wide search finds no member/dependent/audit delete path · every mutation has an audit row with before, after, reason · reason enforced server-side, not just in the form.

---

## 12. DESIGN DIRECTION

Anchor is **the card as a printed object**, not a generic dashboard tile.

**Palette** (insurance-certificate printing, not SaaS default): `--ink #0F2E28` · `--plate #14453C` · `--copper #B46A3A` (single accent) · `--paper #EFF1EE` · `--slate #1A211F` · `--signal #8C2F2A` (errors, archived, denied) · `--muted #6E7A76`.

**Type** (Google Fonts, three roles): **Bricolage Grotesque** display, used sparingly · **Public Sans** body and forms · **IBM Plex Mono** for all identifiers — policy, member, certificate, audit and correlation ids, masked values. Mono is content-driven here: this app's substance *is* identifiers and they must be scannable digit by digit.

**Signature:** the card renders as a plate in `--ink`/`--plate` with hairline `--copper` rules, identifiers set in mono on a visible baseline grid echoing the ruled claim grid on the back of a physical card; dependents in a ruled sub-panel below. Spend the boldness here — keep the admin portal quiet, dense, functional.

**Quality floor, unannounced:** visible focus rings, `prefers-reduced-motion` respected, 4.5:1 body contrast, keyboard-navigable tables, every field labelled.

**Copy:** active voice, sentence case, button text matching the resulting toast (`Archive member` → `Member archived`). Errors say what happened and what to do next. Never `Submit`.

---

## 13. OUT OF SCOPE & BUILD ORDER

**Do not build, stub, or mention in the UI:** claims submission or adjudication · diagnosis, prescription, lab/x-ray capture · payments, billing, contributions · provider/hospital integration · hard delete · wallet passes · QR codes · push notifications · biometrics or device binding · real SMS/email delivery · cloud deployment · dependent self-service logins · localisation beyond English. If you think one is needed, say so and stop.

**Stages — report and wait for `continue` after each:**

1. **Scaffold** — repo layout, `pom.xml`, Vite + Tailwind, Makefile, scripts, README skeleton. Prove `make dev` starts both.
2. **Domain + seed** — nine entities, repositories, seeder. Print credentials and sample identifiers.
3. **RBAC core** — Permission enum, role mapping, ScopeResolver, JwtService, filters, SecurityConfig, MaskingService, AuditService. Write the **48-assertion suite before any controller** — it should fail first, then pass as controllers land.
4. **Admin APIs** — every endpoint annotated, scope-filtered, audited. Swagger reachable.
5. **Employee APIs** — uniform lookup, disambiguation, OTP, card session, card payload.
6. **Frontend** — auth context, permission hooks, employee flow, admin screens, Permission Explorer. Apply §12 throughout.
7. **Local-run hardening** — single JAR, SPA forwarding, Replit script, full README, then walk §11 and print results.

Begin with stage 1.
