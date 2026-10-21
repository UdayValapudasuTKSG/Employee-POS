# Specification Quality Checklist: Multi-Company BHI Enrollment and Monthly Billing on One Shared Database

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-29 (revised 2026-09-29 for the shared-database design)
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

## Notes

- **Revision 2026-09-29.** One schema per company was replaced by one shared database, as the client requires ("one application and one physical DB, with logically segregated data").
  - Premium calculation and monthly billing moved from out of scope to User Stories 5 and 6.
  - Client admin user management was added (User Story 3).
  - plan.md, research.md, data-model.md, quickstart.md and contracts/ were regenerated for the shared-database design on 2026-09-29.
- **Decisions confirmed 2026-09-29:**
  - One person belongs to one company only (FR-007).
  - Classes and standard rates are shared by all companies; company-specific rates are added later in PremiumRates (FR-021, FR-024).
  - The import tables stay as given, with the company traced through an import batch (FR-009).
- **Resolved 2026-09-29:** group admins see only their own client group's companies. The platform admin role is kept as the super admin, the only role that sees and changes all companies (FR-012, FR-013).
- **Deviations from the Access file:** D1 to D3, all on PremiumRates, needed for company-specific rates. Listed in Key Entities, and excluded from SC-001.
- **Interpretation to confirm with the client:** CompanyBillingRule percentages override the rate card's company and employee split (FR-032).
- Schema, table and column terms appear throughout. They are the subject of the feature (the client supplied the data model), not implementation choices.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
