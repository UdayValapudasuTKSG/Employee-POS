# Beharry Staff Discounts

A staff discount app for Beharry Group employees. An employee signs in with
their work email, gets **one code**, and uses it **once** at any one of the
participating stores:

- KFC
- Pizza Hut
- Sterling
- Edward B. Beharry & Co.

The code takes **10% off the bill**, up to **GYD 15,000 of savings per month**
across all four stores. Admins can change each partner's percentage, give a
partner a monthly limit of its own, or switch a partner off, in the admin
portal at `/admin`. Changes apply immediately.

The API and the web app run as one service in this folder. It is separate from
the health card portal in the rest of this repo, with its own database, its own
port and its own `package.json`.

---

## Run it

### With Docker (recommended)

```bash
cp .env.example .env            # fill in every CHANGE_ME
docker compose up -d --build
```

Open http://localhost:3200. The stack is the app plus its own PostgreSQL,
published on `127.0.0.1:5435` for pgAdmin or psql.

- `docker compose down` stops it and keeps the data.
- `docker compose down -v` deletes the database.

### Without Docker

You need Node 20+ and a PostgreSQL 14+ database. In `.env`, point
`DATABASE_URL` at that database.

```bash
npm install
npm run build && npm start      # one process on PORT (3200)
```

For development, run these in two terminals:

```bash
npm run dev:server   # API on 3200, restarts on change
npm run dev:web      # web app on http://localhost:5174, forwards /api to 3200
```

### Checks

```bash
npm run typecheck
npm test
```

---

## Any new database works

On every start the app:

1. **Applies `db/migrations/*.sql`.** Each file runs once and is recorded in
   `schema_migrations`. An empty database gets the whole schema.
2. **Adds the seed employees** from `server/seed.ts`. Only missing ones are
   added; existing records are never changed.

So pointing `DATABASE_URL` at a brand-new database is all a deployment needs.
The seed employees are:

| Email | Number |
|---|---|
| olaiwon@beharrygroup.com | BEH-0001 |
| anand@beharrygroup.com | BEH-0002 |
| rdatla@beharrygroup.com | BEH-0003 |
| udaykumarvalapudasu@gmail.com | BEH-0004 |

Their names are placeholders. Correct them in `server/seed.ts` or in the
`employees` table. To add more employees, add rows to `employees`, or to the
list in `server/seed.ts` and restart.

---

## Admin portal

Open http://localhost:3200/admin.

**Who can sign in.** Admins are the addresses in `ADMIN_EMAILS` in `.env`,
comma-separated. They sign in with an emailed 6-digit code, the same way
employees do, but with separate codes, sessions and cookie, so neither kind of
session works as the other. The list is checked on every request: remove an
address and restart, and that person's access ends even mid-session.

| Page | What it does |
|---|---|
| **Dashboard** | Any of the last 12 months (Guyana time), compared with the month before. See the list below. |
| **Discounts** | The overall monthly allowance per employee, how long a code lasts, and for each partner: its percentage, an optional monthly limit of its own, and an on/off switch. Each card shows a worked example before you save. Every change is recorded in the audit log with who made it. |
| **Employees** | Search, filter by status and page through employees, with each one's savings this month and last use. You can add an employee, or deactivate one, which signs them out and stops their live code working at the till. |

The dashboard shows:

- **Headline figures:** total saved, bills paid with a code, codes used, and
  employees who saved, each compared with last month.
- **Other figures:** average bill, codes generated and the share used, codes
  that expired unused, employees who signed in, employees who reached the
  limit, voided sales and part-discounts.
- **Charts:** savings by day, how much of the allowance employees used, savings
  by store (logos plus a table), the last six months, and busiest hours.
- **Tables:** top savers and the latest sales.

**How the discount is worked out at the till.** The store that redeems the code
sets the percentage. The discount is that percentage of the bill, but never more
than the employee's overall allowance left this month, nor, if the store has its
own limit, what is left of that limit. When either limit binds, the cashier must
confirm the smaller amount, and the message names the store when it is that
store's limit. A switched-off store refuses codes with `STORE_NOT_PARTICIPATING`.
A store limit that is used up gives `STORE_LIMIT_REACHED`, and the same code
still works at the other stores.

**`.env` vs the portal.** `DISCOUNT_PERCENT`, `DISCOUNT_MONTHLY_CAP_GYD` and
`CODE_TTL_MINUTES` are now used only once, to fill the settings the first time
the app starts against a database. After that, the portal is where they change.

### Sample data for the dashboard (local only)

```bash
npx tsx --env-file=.env scripts/demo-activity.ts           # add six months of sample activity
npx tsx --env-file=.env scripts/demo-activity.ts --remove  # remove all of it
```

This adds 30 made-up employees on `@example.test` and their codes, sales and
sign-ins. Every row is tagged `DEMO-…`, so `--remove` takes out exactly that and
nothing else. It refuses to run with `NODE_ENV=production`.

---

## How it works

**Signing in.** The employee enters their work email and gets a 6-digit code by
email. The code:

- lasts 5 minutes and allows 3 tries;
- can be re-sent once a minute;
- is stored as a hash only.

A successful sign-in sets an HttpOnly session cookie that lasts 8 hours.

**One code.** The employee taps *Get my code* and confirms with a second emailed
code. The discount code then appears as a QR code and as text (for example
`K7PQ-3MZX-9TRA`), and a copy is emailed.

- It is valid for 30 minutes.
- The employee holds **at most one live code**. The database enforces this, and
  getting a new code retires the old one.
- The code is stored as a hash for lookup, plus an encrypted copy so the
  employee can see it again on another device.

**At the till.** The cashier scans the code. The till calls the POS API with its
store's key, and the key identifies the store.

**The allowance.**

- Only used codes count against it. A voided sale gives the discount back.
- It renews at 00:00 on the 1st, Guyana time.
- When less than 10% of the bill is left, the till is told the smaller amount
  and must confirm it before it is applied.

### POS API

Every call sends the store's key as `Authorization: Bearer <POS_KEY_…>`.

| Call | Body | Does |
|---|---|---|
| `POST /api/pos/check` | `code`, `billAmount`? | Validates the code and quotes the discount. Records nothing. Returns the holder's name (for example "Uday Kumar V.") so the cashier can check ID. |
| `POST /api/pos/redeem` | `code`, `billAmount`, `posReference`, `storeLocation`?, `confirmPartialDiscount`? | Uses the code and records the discount. Retrying with the same `posReference` returns the same sale. |
| `POST /api/pos/codes/{codeId}/void` | `reason` | Cancels a sale and gives the allowance back. Only the store that redeemed it can void it. |

Errors look like `{"error": {"code", "message"}}`, and the message is written for
the cashier.

| Code | Means |
|---|---|
| `CODE_NOT_FOUND` | Not a valid code |
| `CODE_ALREADY_USED` | Already used; the message names the store |
| `CODE_REPLACED` | The employee has a newer code |
| `CODE_EXPIRED` | Older than 30 minutes |
| `CODE_VOIDED` | Its sale was voided |
| `EMPLOYEE_NOT_ELIGIBLE` | The employee is no longer active |
| `ALLOWANCE_EXHAUSTED` | Nothing left this month |
| `STORE_LIMIT_REACHED` | This store's own monthly limit is used up; the code still works at the other stores |
| `STORE_NOT_PARTICIPATING` | An admin has switched this store off |
| `PARTIAL_DISCOUNT_NOT_CONFIRMED` | Less than 10% left; resend with `confirmPartialDiscount: true` once the cashier agrees. This answer also carries a `quote` |
| `POS_UNAUTHORIZED` | The store key is missing or wrong |

Try it:

```bash
curl -s http://localhost:3200/api/pos/redeem \
  -H "Authorization: Bearer $POS_KEY_KFC" -H "Content-Type: application/json" \
  -d '{"code":"K7PQ-3MZX-9TRA","billAmount":4850,"posReference":"TEST-1"}'
```

### Employee API (used by the web app)

| Call | Does |
|---|---|
| `GET /api/public/terms` | Percentage, cap, code lifetime and stores, for the landing page |
| `POST /api/auth/start` `{email}` | Emails a sign-in code |
| `POST /api/auth/verify` `{challengeId, code}` | Signs in and sets the session cookie |
| `POST /api/auth/logout` | Signs out |
| `GET /api/me` | Name, allowance, the live code, the latest code |
| `POST /api/codes/otp` | Emails a confirmation code |
| `POST /api/codes` `{challengeId, code}` | Makes the discount code and emails a copy |
| `GET /api/codes?store&status&month&page&pageSize` | History, filtered and paged |

### Admin API (used by the admin portal; admin session cookie)

| Call | Does |
|---|---|
| `POST /api/admin/auth/start` `{email}` | Emails a code, if the address is in `ADMIN_EMAILS` |
| `POST /api/admin/auth/verify` `{challengeId, code}` | Signs in |
| `POST /api/admin/auth/logout` | Signs out |
| `GET /api/admin/metrics?month=YYYY-MM` | Everything on the dashboard |
| `GET`, `PUT /api/admin/settings` | The discount settings |
| `GET /api/admin/employees?search&status&page` | Employees, with this month's savings |
| `POST /api/admin/employees` | Adds an employee |
| `POST /api/admin/employees/{id}/active` `{active}` | Activates or deactivates an employee |

---

## Layout

```
employee-discounts/
├── server/            Express API (TypeScript)
│   ├── index.ts       start: migrate, seed, listen
│   ├── rules.ts       the rules: codes, money, the cap, months (unit-tested)
│   ├── auth.ts        one-time codes and sessions
│   ├── email.ts       email templates and sending (unit-tested)
│   ├── seed.ts        employees added on every start
│   └── routes/        auth, employee, pos
├── web/               React + Vite + Tailwind
│   └── src/pages/     Landing, SignIn, Dashboard
├── db/migrations/     SQL, applied on start
├── Dockerfile, docker-compose.yml, .env.example
```

## Before going live

- Set `NODE_ENV=production` and `OTP_DEV_MODE=false`. The app refuses to start
  with `OTP_DEV_MODE=true` in production.
- Generate a new `SESSION_SECRET` and new `POS_KEY_*` values, and send each store
  its key privately.
- Serve it over HTTPS (for example behind nginx) and set `APP_URL` and
  `TRUST_PROXY=1`.
- Set `SEED_DEMO_EMPLOYEES=false`, and if you loaded sample activity, run
  `scripts/demo-activity.ts --remove`.
- Set `ADMIN_EMAILS` to the real admins.
