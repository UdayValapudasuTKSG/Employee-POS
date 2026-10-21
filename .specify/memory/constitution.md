<!--
Sync Impact Report
==================
Version change: TEMPLATE (unfilled) → 1.0.0
Bump rationale: Initial ratification. Template placeholders replaced with concrete governance
derived from BHI Business and Technical Specification v0.1 (2026-07-27) and the KSQUARE
Technical Feasibility Assessment, Solution Validation and Commercial Proposal v0.1 (2026-07-29).

Principles defined (7; template shipped with 5 placeholder slots):
  - [PRINCIPLE_1_NAME] → I. Zero Disclosure Before Verification (NON-NEGOTIABLE)
  - [PRINCIPLE_2_NAME] → II. Layered Identity Assurance
  - [PRINCIPLE_3_NAME] → III. Archive-Only Records and Immutable Audit (NON-NEGOTIABLE)
  - [PRINCIPLE_4_NAME] → IV. Data Residency and Lawful Processing
  - [PRINCIPLE_5_NAME] → V. Usable at the Point of Care
  - (added) VI. Measurable Non-Functional Requirements
  - (added) VII. Observability Without Exposure

Sections added:
  - [SECTION_2_NAME] → Security, Privacy, and Platform Constraints
  - [SECTION_3_NAME] → Development Workflow and Quality Gates
  - [GOVERNANCE_RULES] → Governance

Sections removed: none (template slots were empty).

Deferred TODOs (must be closed before the Phase Gate 2 design freeze):
  - TODO(AVAILABILITY_TARGETS): numeric availability, RTO and RPO for the BHI Data Centre link
    and database (KSQUARE finding F-01). Principle VI mandates numbers; the numbers are not yet
    agreed. Source table (KSQUARE response Section 6.3) not yet baselined.
  - TODO(PERFORMANCE_TARGETS): p95 latency budgets for /lookup, /otp/send, /otp/verify, /card
    and OTP delivery. Same source and same gate.
  - TODO(OTP_PROVIDER): email and SMS gateway selection for Guyana. On the critical path;
    sender ID registration lead time is approximately two weeks.
  - TODO(DATABASE_ENGINE): PostgreSQL or SQL Server, per the BHI Data Centre standard.
  - TODO(RETENTION_SCHEDULE): retention periods per data class under the Data Protection Act 2023.
  - TODO(BASELINE_RERATIFICATION): both source documents are draft v0.1. Re-ratify this
    constitution when BHI spec v1.0 and the KSQUARE response v1.0 are approved.

Templates and commands are not modified by this command; they read the constitution at runtime.
-->

# BHI Health Insurance Digital Card Constitution

This constitution governs the Beharry Holding Inc. Health Insurance Digital Card mobile
application, its backend services, its HR administration portal, and every integration between
them. It exists because the system handles national identification numbers, dates of birth,
policy membership, and dependants' data including that of minors, through a publicly
installable application. The cost of a design mistake here is a personal-data breach affecting
an entire employee population, not a defect ticket.

## Core Principles

### I. Zero Disclosure Before Verification (NON-NEGOTIABLE)

No personally identifiable or health-plan data leaves the backend until the requesting party has
completed a full verification cycle. This is absolute and applies to response bodies, headers,
status codes, timing, and error text alike.

- Pre-verification endpoints MUST return a uniform response whether or not a matching record
  exists. Enumeration of who is and is not a BHI employee is itself a disclosure.
- Failure, lockout, and expiry messages MUST NOT vary in a way that confirms account existence.
- The card payload MUST be assembled only after `/otp/verify` succeeds, and MUST contain only the
  fields on the insurer-approved card layout. Convenience fields are not permitted.
- Multi-record disambiguation (shared household phone numbers and mailboxes) MUST use a
  non-disclosing selection mechanism and MUST be treated as a security review item, never as a
  UX detail.

Rationale: possession of an inbox or a SIM is the weakest link in this system. Everything
downstream of it must assume the caller is hostile until proven otherwise.

### II. Layered Identity Assurance

A single broadcast factor MUST NOT be sufficient to release the card.

- Lookup MUST require a second non-broadcast factor in addition to the registered email address
  or mobile number.
- One-time codes MUST be stored only as hashes, MUST carry a fixed expiry, MUST enforce a retry
  limit with progressive lockout, and MUST be bound to the originating verification session and
  delivery channel.
- `card_token` MUST be single use, MUST have a time-to-live of no more than five minutes, MUST be
  audience-restricted and device-bound, MUST be revocable server-side, and MUST carry no personal
  data in its payload.
- After first enrolment the application MUST bind to the verified device and MUST re-authenticate
  through device biometrics, subject to a configurable maximum re-verification interval. Forcing
  a full one-time code cycle on every launch is a defect, not a hardening measure.
- Rate limiting MUST be applied per identifier, per source address, and globally.
- Administrator access MUST federate to the BHI Microsoft Entra ID tenant with MFA enforced at
  the identity provider. The application MUST NOT hold administrator password material.

Rationale: the verification gate is the entire security boundary of this product. Friction that
drives employees back to the plastic card defeats the project; a single factor that releases a
national ID number defeats the employee.

### III. Archive-Only Records and Immutable Audit (NON-NEGOTIABLE)

Member, policy, and dependant records are never destroyed.

- No hard-delete path may exist in any layer: not in the API, not in the admin portal, not in the
  service layer, not in a database migration, and not in an operational runbook.
- Archive MUST require a reason and MUST render the record ineligible for card retrieval until
  reactivated through an approved workflow.
- Every create, update, archive, and reactivation MUST write an audit entry containing actor,
  action, entity, entity identifier, before value, after value, reason, timestamp, and source
  address.
- Audit storage MUST be append-only and MUST be written under credentials that hold no update or
  delete rights on that store. Asserting immutability in documentation is not implementing it.

Rationale: HR administrators can alter eligibility fields that determine whether a person can
obtain medical care. That power is acceptable only when every use of it is permanently
reconstructable.

### IV. Data Residency and Lawful Processing

The authoritative record stays in the BHI Data Centre, and processing outside it is deliberate,
documented, and minimal.

- Cloud-hosted compute MUST NOT hold direct database connections into the BHI Data Centre. All
  access MUST route through a narrow-purpose on-premise integration service exposing only the
  specific operations required. No database port may be reachable from the cloud estate.
- Any processing of personal data in Google Cloud Platform, Firebase, or BigQuery is a transfer
  outside Guyana and MUST be covered by a documented assessment, a recorded lawful basis, a
  transfer safeguard, a retention schedule, and an executed data processing agreement, all in
  place before go-live.
- BHI is data controller; KSQUARE is data processor and MUST process only on documented BHI
  instruction.
- The data set includes children's personal data. Any change that widens what is collected,
  displayed, cached, logged, or transferred MUST be re-assessed before it ships.
- Encryption keys protecting personal data MUST be customer-managed, with key material held by
  BHI.

Rationale: the Data Protection Act 2023 obligations sit with BHI and cannot be delegated to an
implementation partner or absorbed by a cloud provider's default posture.

### V. Usable at the Point of Care

The card is needed in a clinic, where connectivity is unreliable. A digital card that fails there
is worse than the plastic card it replaces.

- The application MUST retain an encrypted local copy of the approved card payload, gated by
  device biometrics, with an enforced time-to-live and server-side remote revocation.
- A previously verified employee MUST retain card access during a BHI Data Centre or network link
  outage.
- The card MUST present a cryptographically signed, rotating QR code verifiable through a
  provider validation endpoint. Without a trust anchor, a screenshot is indistinguishable from a
  valid card.
- Employment status change MUST propagate to revocation of cached payloads and issued passes.
- Platform capability governs feature framing: where a specified control cannot be implemented on
  a platform, the requirement is reframed to preserve intent rather than shipped as a
  platform-specific stub.

Rationale: availability of the whole service is currently bounded by one data centre and one
network link. Local resilience is not an enhancement, it is the mitigation for that single point
of failure.

### VI. Measurable Non-Functional Requirements

Every non-functional requirement MUST carry a numeric target, a measurement method, and a
measurement point. Terms such as "responsive", "reliable", "fast", or "as appropriate" are not
acceptable in a requirement, a specification, or an acceptance criterion.

- Availability, RTO, RPO, p95 latency per endpoint, OTP delivery latency, crash-free session
  rate, and concurrent-user capacity MUST each have an agreed figure before design freeze.
- Capacity MUST be planned against approximately 4,970 member records with a launch-window burst
  profile, not a sustained-load profile.
- An acceptance criterion that cannot fail a test is not an acceptance criterion and MUST be
  rewritten or removed.

Rationale: the source specification expressed every non-functional requirement in unmeasurable
terms, which makes go-live acceptance untestable and disputes unresolvable.

### VII. Observability Without Exposure

The system MUST be diagnosable in production without any operator reading personal data.

- Analytics and technical events MUST use anonymised user keys, masked contact details, and
  correlation identifiers.
- No personal data, card payload, one-time code, token, or secret may appear in logs, crash
  reports, analytics events, or error messages, in any environment including non-production.
- The event taxonomy MUST cover adoption, verification, card access, performance, administration,
  and security categories, and MUST record failure points and drop-off, not only successes.
- Support tooling MUST let an administrator resolve an employee issue using masked identifiers
  and a correlation identifier alone.

Rationale: troubleshooting access is a standing disclosure risk. Designing it out is cheaper than
governing it.

## Security, Privacy, and Platform Constraints

These constraints are binding on implementation and may be changed only by amendment.

- **Transport and storage**: TLS for mobile-to-cloud, cloud-to-data-centre, and all database
  connections. Encryption at rest for database storage, backups, caches, on-device storage, and
  any log or object store holding sensitive data.
- **Secrets**: API keys, database credentials, messaging credentials, signing keys, and
  certificates live in Secret Manager or Cloud KMS. No secret may appear in source control, a
  build artefact, a container image, or a configuration file.
- **Access**: role-based access control with least privilege for HR administrators, IT support,
  and KSQUARE support. Administrator visibility is scoped to approved companies. Vendor access
  MUST be time-bound, logged, and reviewed by BHI IT.
- **Authorisation**: enforced server-side. Client-side checks are presentation only and are never
  the control.
- **Edge protection**: WAF, rate limiting, and DDoS protection at the gateway, not in bespoke
  application code.
- **Mobile integrity**: platform attestation (Play Integrity, App Attest), hardware-backed
  keystore, and biometric APIs MUST be used rather than reimplemented.
- **Infrastructure as code**: all cloud and on-premise infrastructure MUST be defined in version-
  controlled Terraform with automated build and deployment pipelines. A handover that cannot be
  reproduced from the repository is not a handover.
- **Portability**: services MUST be container-based and free of unnecessary managed-service
  coupling, so that migration to the BHI secure landing zone is a deployment change and not a
  rewrite.
- **Intellectual property**: all intellectual property in the delivered solution vests in Beharry
  Holding Inc. Every deliverable — source, infrastructure definitions, pipelines, schemas,
  runbooks, and documentation — MUST be delivered into BHI-owned repositories and BHI-owned store
  accounts from the outset.

## Development Workflow and Quality Gates

- **Traceability**: every change MUST trace to a numbered requirement. New behaviour discovered
  during build MUST be added as a numbered requirement before it is implemented, not documented
  afterwards.
- **Specification precedence**: where the BHI specification and this constitution conflict, this
  constitution governs, and the conflict MUST be raised as an amendment or a specification
  change. Silent divergence in code is prohibited.
- **Security review gate**: changes touching verification, tokens, disclosure surfaces, caching,
  audit, admin permissions, or data flows crossing the data-centre boundary MUST pass explicit
  security review before merge.
- **Data protection gate**: changes altering what personal data is collected, displayed, cached,
  logged, or transferred MUST pass a data protection review before merge.
- **Testing**: verification, disclosure, offline, revocation, and audit behaviours MUST have
  automated tests. Negative cases — wrong code, expired code, retry exhaustion, replayed token,
  archived member, unauthorised administrator scope — are mandatory, not optional coverage.
- **No production data outside production**: test and demonstration environments MUST use
  synthetic or de-identified data. This includes the persistent App Store reviewer demonstration
  account.
- **Independent penetration test**: the mobile application and API layer MUST pass an independent
  penetration test, commissioned by BHI, before go-live. Findings rated high or critical MUST be
  remediated and retested before release.
- **Release readiness**: no release without completed test evidence, security assessment
  evidence, admin guide, employee quick-start guide, IT runbook, support handover, monitoring
  dashboards, release checklist, and a rehearsed rollback plan.
- **Store submission**: iOS submission MUST occur no later than three weeks before target
  release, with a persistent working reviewer demonstration account, and a managed-distribution
  contingency held in reserve.
- **Data readiness**: employee contact, dependant, policy, group, and member data MUST pass
  cleansing, validation, and sampled HR sign-off before go-live. The entire verification model
  depends on the accuracy of contact records.

## Governance

This constitution supersedes other practices, conventions, and habits on this project. Where a
plan, task list, review comment, or existing implementation conflicts with it, this document
wins and the conflict is resolved by amendment or by changing the work.

**Authority**: the IT Manager (Mr. Ariff) and the Group HR business sponsor jointly approve
amendments. Amendments affecting personal data handling additionally require data protection
sign-off. Amendments affecting card layout, wording, or displayed fields additionally require
NALICO/NAFICO approval.

**Amendment procedure**: propose the change in writing with rationale and impact; obtain the
approvals above; update this file with a new version and Sync Impact Report; state any migration
required for work already in flight. Retroactive amendment to legitimise a shipped deviation is
not permitted.

**Versioning policy**: semantic versioning of this document.
- MAJOR — a principle is removed or redefined in a backward-incompatible way, or a
  NON-NEGOTIABLE principle is relaxed.
- MINOR — a principle or section is added, or guidance is materially expanded.
- PATCH — clarification, wording, or typographical correction with no change in obligation.

**Compliance review**: every specification, plan, and task list produced by the Spec Kit
workflow MUST be checked against these principles before it is accepted. Every pull request MUST
confirm compliance, and any deviation MUST be justified in writing and approved, or the change
does not merge. This constitution is reviewed at each phase gate and at the annual plan
sustainability review.

**Source baselines**: this constitution derives from BHI Business and Technical Specification
v0.1 (2026-07-27) and the KSQUARE Technical Feasibility Assessment, Solution Validation and
Commercial Proposal v0.1 (2026-07-29). Both are draft. This document MUST be re-ratified when
those baselines reach v1.0.

**Note on dates**: the Group Health Insurance Plan commences 1 August 2026. That date is the
business driver for this initiative. It is not a deployment deadline for this application, and
it MUST NOT be used to justify waiving a gate in this constitution.

**Version**: 1.0.0 | **Ratified**: 2026-08-06 | **Last Amended**: 2026-08-06
