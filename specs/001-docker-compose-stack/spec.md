# Feature Specification: Containerised Portal Stack

**Feature Branch**: `dev` (no dedicated feature branch created — no `before_specify` git hook is configured)

**Spec Directory**: `specs/001-docker-compose-stack`

**Created**: 2026-08-11

**Status**: Draft — ready for planning (all clarifications resolved 2026-08-11)

**Input**: User description: "Containerize the health insurance card application with Docker Compose. I have Docker Desktop; I need a compose config file so the whole stack (app services + database) comes up from configuration and connects together via Docker."

## Overview

Today, running the BHI Health Card Portal requires a developer to install and configure PostgreSQL on the host, create a database role by hand, load a schema plus nine migrations, install a specific Node version, and start three to four processes. `deploy/LOCAL-DEV.md` documents this as two separate paths because the source-build path does not work on Windows at all: the workspace pins Linux-only native binaries, and the document's own recommended remedy is *"run in WSL2 / Docker, where the existing lockfile is correct."*

This feature replaces that setup with a single declarative stack configuration. One command brings up the database, the API, the web front door, and local verification-code delivery, already wired together and already initialised — on any machine with a container runtime and nothing else installed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Bring the whole portal up with one command (Priority: P1)

A developer clones the repository onto a machine with only Docker Desktop installed. They copy an example configuration file, run one documented command, and wait. When it finishes, the portal login page loads in a browser and they can sign in as an administrator. They installed no database server, no language runtime, and edited no files beyond the configuration copy.

**Why this priority**: This is the entire point of the feature. Every other story is an improvement on a stack that must first exist and start. It is also the story that removes the current hard blocker — the portal cannot be built from source on Windows today.

**Independent Test**: On a machine with a container runtime and no PostgreSQL or Node installed, run the documented start command from a fresh clone and confirm the admin login page loads and accepts the configured administrator credentials.

**Acceptance Scenarios**:

1. **Given** a clean machine with only a container runtime installed, **When** the developer runs the documented start command, **Then** the portal front page is reachable in a browser and the API reports healthy.
2. **Given** the stack is running, **When** the developer signs in with the configured administrator account, **Then** the admin portal loads with its navigation available.
3. **Given** no configuration file has been created yet, **When** the developer runs the start command, **Then** the stack fails immediately with a message naming the missing file and the command to create it — it does not start half a stack or fall back to unsafe defaults.
4. **Given** a host port required by the stack is already occupied, **When** the developer starts the stack, **Then** the failure message names the conflicting port and states how to change it in configuration.

---

### User Story 2 - Database is created, migrated, and keeps its data (Priority: P1)

The developer never touches the database directly. On the stack's first start, the database is created, the required extension enabled, the schema loaded, and every migration applied in order. On later starts, the same initialisation runs harmlessly and the data entered previously is still there. A separate, explicit command discards the data and starts clean.

**Why this priority**: Equal-first with Story 1 — a stack that starts but loses every record on restart, or that requires a manual schema load, has not replaced the current setup. The existing `setup-local.ps1` is idempotent and the containerised stack must not regress that.

**Independent Test**: Start the stack, create a company through the admin portal, stop the stack, start it again, and confirm the company is still listed. Then run the documented reset command and confirm the database returns to its initial state.

**Acceptance Scenarios**:

1. **Given** a first-ever start with no existing database, **When** the stack comes up, **Then** every table defined by the schema and migrations exists and the API does not report a schema-out-of-date error.
2. **Given** records were created through the portal, **When** the stack is stopped and started again, **Then** all of those records are still present.
3. **Given** a running stack, **When** the initialisation runs a second time, **Then** it completes without error and changes nothing.
4. **Given** a new migration file is added to the migrations directory, **When** the stack is restarted, **Then** the new migration is applied and the API reports the schema current.
5. **Given** the developer runs the documented reset command, **When** the stack next starts, **Then** the database is empty of prior records and re-initialised from scratch.

---

### User Story 3 - The API waits for the database instead of crash-looping (Priority: P1)

The developer starts the stack and watches one stream of logs. The API does not begin serving, and does not repeatedly crash and restart, until the database is genuinely accepting connections and the schema is loaded. The startup output makes clear which service is still coming up.

**Why this priority**: Containerised stacks fail here by default — the database container is "started" long before it accepts connections. Without ordering, first-run experience is a wall of connection errors, which is exactly the confusion this feature exists to remove.

**Independent Test**: Start the stack from cold on a machine where database initialisation takes tens of seconds, and confirm the log stream shows an orderly wait followed by a successful API start, with no connection-refused errors and no restart loop.

**Acceptance Scenarios**:

1. **Given** a cold start where the database takes time to initialise, **When** the stack comes up, **Then** the API starts serving only after the database is ready, and logs no database-connection failures.
2. **Given** the database becomes unavailable while the stack is running, **When** the operator checks readiness, **Then** the health endpoint still answers and the readiness endpoint reports unavailable — distinguishing a dead process from a dead database.
3. **Given** the stack is starting, **When** the developer watches the logs, **Then** each line identifies which service produced it.

---

### User Story 4 - End-to-end verification works with no external provider (Priority: P2)

The developer opens the employee lookup page, enters a seeded member's email address or phone number, and retrieves the one-time code from a local inbox view. Entering it returns the member's card. No SMTP account, SMS provider, or paid service was configured.

**Why this priority**: Verification is the core of the product and the whole security boundary. A stack where the primary employee journey cannot be exercised is a partial demo, not a replacement for the current setup — which does support this today via a local delivery sink.

**Independent Test**: From a freshly started stack with the demo dataset, complete a full lookup → code → verify → card flow using only the local inbox, with no external credentials configured anywhere.

**Acceptance Scenarios**:

1. **Given** a running stack with the demo dataset loaded, **When** a member email is submitted for lookup, **Then** the code is captured locally and readable through the inbox view within a few seconds.
2. **Given** a code has been captured, **When** it is entered, **Then** the member's card is returned.
3. **Given** a member phone number shared by several members is submitted, **When** the lookup runs, **Then** the non-disclosing disambiguation step is presented before any code is sent.
4. **Given** local delivery is deliberately disabled in configuration, **When** a lookup is attempted, **Then** the portal reports that codes cannot be delivered rather than implying one was sent.

---

### User Story 5 - Configuration is data, and secrets stay out of the repository (Priority: P2)

Every value the stack needs — database credentials, session secret, administrator account, ports, card issuer details, delivery settings — lives in a configuration file the developer owns. The repository carries only an example with placeholder values. Changing a value is an edit and a restart, never a rebuild or a code change.

**Why this priority**: The constitution forbids secrets in source control, build artefacts, container images, and configuration files under version control. It also requires that card issuer details remain configuration so a different insurer deploys without a rebuild. Both properties must survive containerisation.

**Independent Test**: Change the administrator email and an issuer field in the configuration file, restart the stack, and confirm both changes take effect with no rebuild. Separately, search the repository and the built images for any real secret value and find none.

**Acceptance Scenarios**:

1. **Given** the example configuration file, **When** a developer copies it and fills in values, **Then** the stack starts using those values.
2. **Given** a configuration value is changed, **When** the stack is restarted, **Then** the new value is in effect without rebuilding any image.
3. **Given** the repository at any commit, **When** it is inspected for secrets, **Then** no real credential, session secret, or provider token is present — only placeholders.
4. **Given** a built image, **When** its contents and build history are inspected, **Then** no secret value is baked into it.
5. **Given** a required configuration value is absent, **When** the stack starts, **Then** it fails with a message naming the missing value rather than starting with an insecure default.

---

### User Story 6 - Change source, rebuild, see it running (Priority: P2)

A developer edits application source on their Windows host, runs one command, and the stack comes back with the change in effect. They did not install a toolchain, did not regenerate a bundle by hand, and did not lose the data already in their database.

**Why this priority**: Building from source is the decision that makes this repository workable on Windows at all, but the value only lands if the edit-rebuild-run cycle is short enough to use. A stack that must be torn down and re-created for every change would push developers back to the current setup.

**Independent Test**: Make a visible change to a source file, run the documented rebuild command, and confirm the change is live in the browser and that previously created records are still present.

**Acceptance Scenarios**:

1. **Given** a running stack, **When** a source file is changed and the documented rebuild command is run, **Then** the change is in effect and the database contents are unchanged.
2. **Given** dependencies have not changed since the last build, **When** a rebuild runs, **Then** dependency installation is reused from cache rather than repeated.
3. **Given** a source file contains an error that breaks the build, **When** a rebuild runs, **Then** it fails with the compiler's own message identifying the file, and the previously running stack is not left in a broken half-state.
4. **Given** the developer is working on a Windows host, **When** the build runs, **Then** it succeeds despite the workspace excluding Windows native binaries.

---

### User Story 7 - Existing automated tests pass against the stack (Priority: P3)

A developer points the existing RBAC suite at the containerised stack and gets the same result the current documented setup produces, without modifying the tests.

**Why this priority**: Valuable as proof that the containerised stack is behaviourally equivalent rather than merely superficially similar, but the stack delivers its main value before this is wired up.

**Independent Test**: Start the stack in the mode the suite requires and run the existing RBAC suite against it, comparing the pass count to the documented baseline.

**Acceptance Scenarios**:

1. **Given** the stack running in the mode the suite requires, **When** the existing RBAC suite is run against a freshly seeded database, **Then** it reports the same pass and fail counts as the documented baseline for that mode.
2. **Given** the suite is run against the stack in its default mode, **When** results are compared, **Then** any differences are limited to the known mode-dependent assertions already documented.

---

### Edge Cases

- A host port the stack needs (front door, API, database, local mail) is already taken — including the documented case of an existing host PostgreSQL on the database port and an IDE process holding the API's production port. The failure must name the port and the setting that moves it.
- The developer's machine already runs the non-containerised stack from `pnpm run local`; both cannot hold the same ports.
- The stack is stopped abruptly (machine sleep, Docker Desktop restart, power loss) mid-write — data must not be silently corrupted, and the next start must either recover or report clearly.
- The database volume exists from an older schema version while the application images are newer — the schema-out-of-date condition must surface as the existing explicit error, not as scattered query failures.
- Source files are edited on a Windows host while the stack runs — file-watching and line-ending differences across the host/container boundary must not silently break the build or produce corrupted files.
- The demo seed flag is left enabled while the configuration points at a database holding real member data — this must be prevented or loudly warned, as seeded accounts have publicly documented passwords.
- The developer runs the reset command by accident — destructive actions must require an explicit, distinct command and must not be a side effect of an ordinary stop.
- Disk space runs out during first-run image build or database initialisation.
- The container runtime is running Windows containers rather than Linux containers.
- Two developers start the stack on the same machine, or the same developer starts it twice from two clones.

## Requirements *(mandatory)*

### Functional Requirements

**Stack definition and lifecycle**

- **FR-001**: The complete stack MUST be defined in version-controlled configuration files committed to the repository, with no manual host setup step required beyond installing the container runtime and copying an example configuration file.
- **FR-002**: The stack MUST include, at minimum, a database service, the API service, a web front-door service, and local verification-code delivery.
- **FR-003**: A single documented command MUST start the entire stack; a single documented command MUST stop it; a separate, explicitly destructive command MUST reset persisted data.
- **FR-004**: Stopping the stack MUST NOT destroy persisted data. Only the explicit reset command may do so.
- **FR-005**: The stack MUST run on a container runtime on Windows with no host-installed database server and no host-installed language runtime.
- **FR-006**: Services MUST be reachable from each other by stable internal names, so that no service configuration depends on a host address or a dynamically assigned address.

**Database**

- **FR-007**: On first start the stack MUST create the application database and role, enable the required database extension, load the schema, and apply every migration in filename order.
- **FR-008**: Initialisation MUST be idempotent — running it against an already-initialised database MUST complete without error and change nothing.
- **FR-009**: Migration files added later MUST be applied on the next start without a manual step.
- **FR-010**: Database contents MUST persist across stack stop, start, restart, and image rebuild.
- **FR-011**: The database MUST be at a version compatible with the existing schema, which was generated with PostgreSQL 16 and is documented as requiring PostgreSQL 14 or newer.

**Startup ordering and health**

- **FR-012**: The API MUST NOT begin serving requests until the database is accepting connections and initialisation has completed. Ordering MUST be enforced by an actual readiness check, not a fixed delay.
- **FR-013**: The stack MUST expose the existing health and readiness endpoints unchanged, so an operator can distinguish a stopped process from an unreachable database.
- **FR-014**: A service that fails MUST surface a message identifying which service failed and why, in the aggregated log stream.
- **FR-015**: Log output MUST attribute every line to the service that produced it.

**Web front door**

- **FR-016**: The front door MUST serve the built frontend and proxy API requests to the API service on the same origin, with single-page-application fallback for client-side routes, matching the existing production routing contract.
- **FR-017**: The API MUST NOT be published to the host network on its own port unless explicitly enabled in configuration — the front door is the intended entry point, mirroring the production posture where the API binds to loopback only.

**Configuration and secrets**

- **FR-018**: All runtime configuration MUST be supplied through environment configuration files, using the existing variable names documented in `deploy/api/.env.example`.
- **FR-019**: An example configuration file with placeholder values MUST be committed; files containing real values MUST be excluded from version control.
- **FR-020**: No secret value MUST appear in the repository, in a committed configuration file, in a container image layer, or in image build history.
- **FR-021**: Host port mappings MUST be overridable through configuration without editing the stack definition.
- **FR-022**: Changing any configuration value MUST take effect on restart without rebuilding an image.
- **FR-023**: When a required configuration value is missing, the stack MUST fail at startup with a message naming the missing value, rather than starting with a default that weakens security.

**Verification-code delivery**

- **FR-024**: The stack MUST capture verification codes locally and make them readable to the developer, so the full employee lookup journey can be exercised with no external provider configured.
- **FR-025**: Local capture MUST be replaceable by a real provider through configuration alone, with no code or stack-definition change.
- **FR-026**: When delivery is unavailable, the portal MUST report that codes cannot be delivered rather than implying one was sent.

**Data protection and constitutional constraints**

- **FR-027**: The stack MUST use only synthetic or de-identified data by default. The demo seed dataset MUST be explicitly flagged and MUST NOT be enabled against a database holding real member data.
- **FR-028**: No personal data, verification code, card payload, token, or secret MUST appear in the aggregated container log output.
- **FR-029**: The stack MUST NOT introduce any hard-delete path for member, policy, or dependant records. The reset command operates on the whole development database as a unit and MUST be documented as a development-only action.
- **FR-030**: Existing audit-write behaviour MUST be unaffected by containerisation.

**Documentation**

- **FR-031**: The existing local-development documentation MUST be updated to describe the containerised path, including start, stop, reset, log inspection, port overrides, and troubleshooting for the port-conflict and stale-schema cases.
- **FR-032**: The documentation MUST state how the containerised path relates to the two paths already documented in `deploy/LOCAL-DEV.md` — which of them it supersedes, and which remain valid — so a developer is never left choosing between three undifferentiated options.

**Scope boundary — development only**

- **FR-033**: The stack MUST be a development tool only. It MUST NOT be presented, documented, or configured as a way to deploy a staging or production environment.
- **FR-034**: The documentation MUST carry a prominent statement that this stack is for developer machines only, naming the existing web-server-plus-service-unit path as the supported deployment route.
- **FR-035**: The stack MUST NOT alter, replace, or interfere with the existing production deployment assets under `deploy/` — the site configuration, the service unit, and the release packaging script all keep working exactly as they do today.
- **FR-036**: The stack MUST NOT be required in order to build a production release. The existing release process MUST remain runnable without the container runtime.

**Image contents — built from source**

- **FR-037**: Application images MUST be built from the source in this repository, not from the committed prebuilt bundles under `deploy/`.
- **FR-038**: The build MUST succeed on a Windows host with no toolchain installed on that host and no edits to any committed file. It runs inside a Linux container, where the workspace's `sh`-syntax build scripts execute in the shell they were written for and no host shell or package-manager difference can intervene.
- **FR-039**: The build MUST NOT depend on any toolchain installed on the host — no host package manager, compiler, or language runtime.
- **FR-040**: Source is the single source of truth for what the stack runs. The stack MUST NOT silently fall back to a committed prebuilt bundle, so that a stale bundle can never be mistaken for current code.
- **FR-041**: A single documented command MUST rebuild the images after a source change and restart the affected services.
- **FR-042**: Repeat builds with unchanged dependencies MUST reuse cached work rather than reinstalling dependencies from scratch.

**Front door — production web server with separate delivery capture**

- **FR-043**: The front door MUST be the same web server used in production, driven by the existing committed site configuration, so that the routing, proxy, and header behaviour exercised locally is the behaviour that ships.
- **FR-044**: The request-correlation header contract MUST be preserved, so a single reference from an error message finds the request in both the front-door log and the API log.
- **FR-045**: Verification-code capture MUST run as its own service, separate from the front door, and its inbox view MUST be reachable through the front door on the same origin as the portal.
- **FR-046**: The stack MUST NOT include any shortcut that accepts a verification code other than the one actually issued. The real code path — hash comparison, attempt counting, lockout — MUST be exercised locally exactly as in production.
- **FR-047**: Where the front-door configuration must differ locally from production (host names, TLS termination, upstream addresses), the differences MUST be confined to configuration and MUST be documented, not achieved by maintaining a divergent copy of the site configuration.

### Key Entities

- **Stack Definition**: The version-controlled description of which services exist, how they connect, what they depend on, and which data persists. The single source of truth for what "the stack" is.
- **Configuration Profile**: The set of values a developer supplies — credentials, secrets, ports, administrator account, issuer details, delivery settings. Owned by the developer, never committed with real values, mirrored in the repository by an example carrying placeholders only.
- **Persistent Data Volume**: The storage holding database contents independently of any service's lifetime. Survives stop, start, and rebuild; removed only by the explicit reset action.
- **Initialisation Set**: The schema definition plus the ordered migration files, applied on start. Grows over time and must apply cleanly to both a new and an existing database.
- **Service**: A single running component of the stack — database, API, front door, delivery capture — with a stable internal name, a readiness condition, and attributed log output.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer with only a container runtime installed goes from a fresh clone to a loaded portal login page by running one documented command, in under 15 minutes on first run.
- **SC-002**: Subsequent starts reach a fully ready stack in under 90 seconds.
- **SC-003**: The number of host prerequisites beyond the container runtime is zero — no database server, no language runtime, no manual database setup script.
- **SC-004**: The complete employee journey — lookup, receive code, verify, view card — completes on a freshly started stack with no external provider account configured.
- **SC-005**: 100% of records created through the portal survive a stop-and-start cycle.
- **SC-006**: Two developers on different machines produce the same running stack from the same committed configuration, with no machine-specific edits to any committed file.
- **SC-007**: The existing RBAC suite run against the containerised stack reports the same pass and fail counts as the documented baseline for the equivalent mode (79 passing, 0 failing in dev-code mode against a freshly seeded database).
- **SC-008**: Zero secret values are present in the repository or in any built image, verified by inspection.
- **SC-009**: For each of the documented failure cases — occupied port, missing configuration value, stale schema, unavailable database — the operator can identify the responsible service and the corrective action from the startup or log output alone, without reading source code.
- **SC-010**: A developer can build and run the portal from source with no host toolchain, no host database, and no edits to any committed file — none of which is possible today.
- **SC-011**: Zero verification codes are accepted that were not actually issued — the local stack has no code-bypass shortcut.
- **SC-012**: The front-door configuration exercised locally is the same committed file used in production; local differences are limited to a documented, enumerable list of configuration values rather than a forked copy.
- **SC-013**: After a source change, one documented command returns the stack to a running state with the change applied, in under 3 minutes when dependencies are unchanged.

## Assumptions

- **Target runtime**: Docker Desktop on Windows 11 using the Linux container engine (WSL2 backend). Windows containers are out of scope.
- **No application changes**: This feature packages and orchestrates the existing application. It does not change API behaviour, the database schema, the card layout, the verification logic, or the frontend. **One scoped exception**: `deploy/local-delivery.mjs` hard-binds its listeners to loopback, which is unreachable across containers, so it gains an optional bind-host variable defaulting to the current value. It is development tooling, ships in no release, and every existing invocation behaves identically.
- **Demo dataset**: The stack defaults to the existing synthetic demo dataset (6 companies, 120 members, 5 administrator accounts). This satisfies the constitutional requirement that non-production environments carry no production data.
- **Local delivery included, as its own service**: The existing local delivery capture is part of the stack by default and runs separately from the front door, because without it the primary employee journey cannot be exercised and lookups correctly fail closed. The current local front door's "any 6-digit code is accepted" convenience is deliberately **not** carried over — it exists only in the development front door being replaced.
- **First build is slow, later builds are not**: Building from source means the first start pays a dependency-installation and compilation cost. This is accepted as a one-time price for making the repository buildable on Windows at all.
- **Default ports**: The stack defaults to the ports already documented for local development, all overridable through configuration. The documented conflicts — an existing host PostgreSQL, and an IDE process holding the API's production port — are treated as expected conditions, not errors to be designed around.
- **Database engine**: PostgreSQL, consistent with the existing schema and connection string. The constitution records the final engine choice as an open decision for the real deployment; this feature follows the existing codebase and does not settle that decision.
- **Existing artefacts are reused**: The schema, migrations, environment variable names, front-door routing contract, and health endpoints are taken as given and are not redesigned.
- **Not a substitute for real infrastructure**: The constitution requires cloud and on-premise infrastructure to be defined in version-controlled Terraform. A stack definition for developer machines does not satisfy that requirement and does not attempt to.
- **Constitution alignment is inherited, not re-litigated**: This feature must not weaken any existing control. Where the constitution mandates container-based, portability-friendly services, this feature moves toward that; where it mandates measurable non-functional targets, the numbers in Success Criteria above apply to developer-experience outcomes only, not to the production service levels still recorded as open in the constitution.

## Out of Scope

- Production or staging deployment, orchestration, scaling, and rollout
- Infrastructure-as-code definitions for cloud or on-premise environments
- Continuous integration or delivery pipeline changes
- Container image publishing to any registry
- Changes to application code, database schema, card layout, or the production web server configuration's semantics
- The mobile application
- Selection of a real email or SMS provider
- Removing or regenerating the committed prebuilt bundles under `deploy/` — they continue to serve the existing deployment path and release packaging, and are simply not what this stack runs
- Fixing the workspace's Windows native-binary exclusions on the host. The container sidesteps them; changing `pnpm-workspace.yaml` is a separate decision with consequences for the Replit deployment

## Dependencies

- An installed container runtime on the developer's machine
- The buildable source under `artifacts/` and the workspace lockfile, which must remain correct for Linux
- The existing committed front-door site configuration under `deploy/nginx/`
- The existing schema and migration files under `deploy/db/`
- The existing environment variable contract in `deploy/api/.env.example`
