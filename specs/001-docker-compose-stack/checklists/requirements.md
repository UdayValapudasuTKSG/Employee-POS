# Specification Quality Checklist: Containerised Portal Stack

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-11
**Last validated**: 2026-08-11 (iteration 2 — after clarifications resolved)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

**All 16 items pass.** Spec is ready for `/speckit-plan`.

## Clarifications Resolved (2026-08-11)

| # | Decision | Chosen | Requirements added |
|---|----------|--------|--------------------|
| 1 | Scope boundary | Development machines only | FR-033 – FR-036 |
| 2 | Image contents | Built from source, not from committed bundles | FR-037 – FR-042 |
| 3 | Front door | Production web server + separate delivery capture service | FR-043 – FR-047 |

Consequential edits: User Story 6 added (edit → rebuild → run cycle, P2); prior Story 6 renumbered to 7;
SC-011 – SC-013 added; FR-032 rewritten to a distinct documentation requirement after FR-034 absorbed its
original intent; Assumptions, Dependencies, and Out of Scope updated.

## Notes

- **On "no implementation details"**: the container runtime is a constraint the user stated explicitly, so
  naming it is a given, not a leak. The spec deliberately avoids naming base images, stack-definition
  syntax, service names, or orchestration primitives — those belong in `plan.md`.

- **On measurability under Constitution Principle VI**: every Success Criterion carries a number or a
  binary condition. The timing figures (SC-001, SC-002, SC-013) are developer-experience targets for this
  feature only. They are not, and must not be read as, the production availability, RTO, RPO, or p95
  latency figures that the constitution records as open TODOs pending the Phase Gate 2 design freeze.

- **Constitutional constraints carried into requirements**: no secrets in source or images (FR-020),
  synthetic data only outside production (FR-027), no personal data in logs (FR-028), no hard-delete path
  (FR-029), audit behaviour unaffected (FR-030), no verification bypass (FR-046). Traceability per the
  Development Workflow gate is satisfied by numbered FRs.

- **Constitution Principle II interaction**: FR-046 removes the "any 6-digit code" convenience that the
  current local front door provides. This is a deliberate tightening — the local stack will exercise the
  real hash comparison, attempt counting, and lockout path. Expect demo flows to need the inbox view.

- **Open constitutional TODO, not blocking**: `TODO(DATABASE_ENGINE)` (PostgreSQL vs SQL Server) remains
  open in the constitution. This spec follows the existing codebase (PostgreSQL) and does not settle it.
  Because the scope is development-only (FR-033), that decision is not blocked by this feature and this
  feature is not blocked by it.
