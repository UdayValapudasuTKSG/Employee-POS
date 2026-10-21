# Feature Specification: Multi-Company BHI Enrollment and Monthly Billing on One Shared Database

**Feature Branch**: `002-per-company-schema` (folder name kept; the per-company-schema approach was replaced on 2026-09-29)

**Created**: 2026-09-29

**Revised**: 2026-09-29. The design changed from one schema per company to one shared database, following the client requirements below. Premium calculation and monthly billing were added to scope.

**Status**: Draft

**Input**: User description: "Replace the existing data structure with the client's BHI Enrollment Database model (Access, schema-only file dated 2026-08-28), including the tables that are not in the relationships diagram. All companies' data is held in one shared database and kept apart by company."

**Client requirements** (received 2026-09-29):

- *Premium structure.* Members sit in classes (currently A, B, C), and new classes must be addable. Each class has four tiers: Employee only, +1, +2, and more than two. There is no cap on registered dependents. The premium varies only up to +2, and beyond that one flat rate applies. Every dependent costs the same, whether spouse, child, newborn or parent. A class change plus a new dependent triggers recalculation, across all customers. The rate card lives in the Access tables.
- *Current process.* Billing runs on a temporary, simple MS Access database: headcount per class × dependents × predefined rate.
- *Billing cycle.* Billing is monthly, not annual/12. Additions and removals take effect from the start of the next month, so each bill differs.
- *Rates going forward.* Premiums must be editable and company-specific. A standard rate applies today. After a one-year performance review, NALICO moves to individual company rates.
- *Multi-company.* The application should serve policyholders beyond the Beharry group. It will be one application and one physical DB, with logically segregated data. For example, Nalico can't see Sterling. NALICO prefers a single DB for cross-company queries. NALICO issues one admin login per client at onboarding, and the client admin manages its own users.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hold every company's enrollment data in the BHI model (Priority: P1)

All client companies' members, dependents, beneficiaries, classes, rates and billing are stored in the 18 tables of the BHI Enrollment Database, in one shared database. Each record belongs to one company.

**Why this priority**: Every other story reads or writes these tables.

**Independent Test**: Compare the database structure with the Key Entities section, table by table and column by column. The only differences allowed are those listed under "Deviations from the Access file".

**Acceptance Scenarios**:

1. **Given** the new structure is in place, **When** it is inspected, **Then** all 18 tables exist with the columns, sizes, required flags, keys, indexes and relationships in Key Entities.
2. **Given** members of two companies, **When** they are stored, **Then** they sit in the same Member table, told apart by CompanyNumber, and their MemberIDs never collide.
3. **Given** a person already registered as a member of one company (same ID type and ID number), **When** any company tries to add them again, **Then** the addition is refused. A company-scoped user is told the ID is already registered on the platform and to contact NALICO, without naming the other company.

---

### User Story 2 - Keep each client's data apart (Priority: P1)

Sterling's users never see NALICO's, Beharry's or anyone else's members, bills or imports, and the same holds for every client. NALICO's platform administrators can query across all companies.

**Why this priority**: The client requires logical segregation in a single database.

**Independent Test**: Load two companies, then use every screen, API, report and export as each company's users. Confirm none can read or change the other's data, while a super admin can read both.

**Acceptance Scenarios**:

1. **Given** users of Company A and Company B, **When** a Company A user reads or writes any record (members, dependents, beneficiaries, bills, import exceptions, users, audit), **Then** only Company A's records are reached.
2. **Given** a company-scoped user asks for a record of another company, **When** the request is made, **Then** it is refused with the same response as a record that does not exist.
3. **Given** a feature that forgets to filter by company, **When** a company-scoped user uses it, **Then** they still receive only their own company's rows.
4. **Given** a super admin, **When** they run a cross-company list, dashboard or report, **Then** it covers every company in one result, and each row shows its company.
5. **Given** the client admin of one Beharry company (for example, Beharry Foods), **When** they use the portal, **Then** they reach only that company, and never a sister company (for example, Beharry Automotive) or another client's (for example, Sterling).
6. **Given** a support user or an auditor, **When** they view any company's data, **Then** they can read it but cannot change anything, as today.
7. **Given** an employee using the card lookup, **When** they enter their email or phone number, **Then** every company is searched, and the response before verification is the same for no match, one match or several.
8. **Given** the contact matches exactly one member, **When** the employee completes verification, **Then** their card is shown.
9. **Given** the contact matches several members in one company, **When** the employee completes verification, **Then** they choose their record, as today.
10. **Given** the contact matches members in two or more companies, **When** the employee completes verification, **Then** no card is shown and they see "Your details were found in more than one company. Please contact your HR department." An alert is recorded for super admins.

---

### User Story 3 - Onboard a client and let its admin manage its users (Priority: P1)

NALICO onboards a new client company. The system creates the company and one client admin login, and the client admin then creates and manages its own users.

**Why this priority**: The platform must serve policyholders beyond the Beharry group, and NALICO issues one admin login per client.

**Independent Test**: Onboard a test company, sign in as its client admin, create an HR user, and confirm neither user can reach any other company.

**Acceptance Scenarios**:

1. **Given** a super admin, **When** they onboard a company with its number, name, contact details and the client admin's email, **Then** the company is created, one client admin login is issued, and the company is ready for members with no code release.
2. **Given** a company number that already exists, **When** onboarding is attempted, **Then** it is refused and nothing is created.
3. **Given** a client admin, **When** they create, edit, deactivate or reactivate a user, **Then** that user belongs to the client admin's own company. The only roles offered are company-scoped ones.
4. **Given** a client admin, **When** they try to create a platform, group, support or auditor user, or a user of another company, **Then** the action is refused.
5. **Given** a company with one active client admin, **When** that admin tries to deactivate or demote themselves, **Then** it is refused, so the company is never left without an admin.
6. **Given** NALICO offboards a company, **When** the offboarding completes, **Then** the company and its users are inactive, it no longer appears in the card lookup or billing, and all its records are kept.

---

### User Story 4 - Move the existing data into the BHI model (Priority: P1)

The data in the current tables is moved into the BHI tables in the same database, then the application switches over.

**Why this priority**: The current structure is being replaced, so its data must be carried over.

**Independent Test**: Rehearse on synthetic or de-identified data shaped like production, and compare per-company, per-table counts before and after.

**Acceptance Scenarios**:

1. **Given** the current tables, **When** the migration runs, **Then** every company, member, dependent and beneficiary is either loaded into the BHI tables or recorded as an exception with a reason.
2. **Given** a completed migration, **When** the reconciliation report is produced, **Then** loaded plus held equals the source count for every company and table.
3. **Given** a member whose status today is active, suspended, removed or archived, **When** they are migrated, **Then** an active member becomes Active = true. Any other status becomes Active = false, with InactiveDate and InactiveReason set. Card access is the same after cut-over as before.
4. **Given** a legacy member with no ID type or class code, **When** the migration runs, **Then** they are not loaded, and they are recorded as an exception against their company with the missing fields.
5. **Given** the same ID type and ID number exists in two companies in the current data, **When** the migration runs, **Then** every record in that set is held as an exception for NALICO to resolve, and none is loaded.
6. **Given** migration exceptions for a company, **When** its HR opens bulk import, **Then** they see only their own company's exceptions, can upload the missing values, and each corrected member is loaded with their dependents and beneficiaries.
7. **Given** reconciliation is signed off, **When** cut-over happens, **Then** the application uses only the BHI tables. The old tables are kept read-only, and later archived rather than deleted.

---

### User Story 5 - Manage classes and the rate card (Priority: P2)

NALICO maintains the classes and the premium rate card. Every class has four tiers. One standard rate applies to all companies today, and company-specific rates can be introduced later without a code release.

**Why this priority**: Billing needs a complete rate card. New classes and company-specific rates are expected, but not on day one.

**Independent Test**: Add class D with its four tier rates. Add a company-specific rate for one company. Confirm billing picks the company rate for that company and the standard rate for all others.

**Acceptance Scenarios**:

1. **Given** classes A, B and C, **When** a super admin adds class D, **Then** it is available to every company. It can be assigned to members once all four tier rates for D exist.
2. **Given** a class, **When** its rates are set, **Then** there is one rate for each of the four tiers: Employee only, +1, +2 and more than two.
3. **Given** a standard rate and no company-specific rate for Company A, **When** Company A is billed, **Then** the standard rate is used.
4. **Given** a company-specific rate for Company A with an effective date, **When** Company A is billed for a month on or after that date, **Then** the company rate is used. Every other company still uses the standard rate.
5. **Given** a rate change, **When** it is saved, **Then** it takes effect from its effective date. Earlier rates are kept and bills already finalised are unchanged.
6. **Given** a class that members or rates use, **When** it is retired, **Then** it stays on existing members, cannot be chosen for new ones, and is never deleted.
7. **Given** a client admin or HR user, **When** they try to change classes or rates, **Then** the action is refused. They can view the rates that apply to their own company.

---

### User Story 6 - Produce the monthly bill for each company (Priority: P2)

Each month NALICO produces one bill per company. There is one line per covered member, priced from the member's class and tier, with the start-of-next-month rule applied.

**Why this priority**: This replaces the temporary Access billing process.

**Independent Test**: For a test company, record additions, removals, a class change and a new dependent in September. Generate September's and October's bills, and check every line against a hand calculation.

**Acceptance Scenarios**:

1. **Given** a company and a month, **When** the bill is generated, **Then** there is one billing run for that company and month, with one line per member covered at the start of that month.
2. **Given** a member with 0, 1, 2, 3 or 7 active dependents, **When** they are billed, **Then** their tier is Employee only, +1, +2, more than two, and more than two respectively.
3. **Given** dependents of different relationships (spouse, child, newborn, parent), **When** the tier is worked out, **Then** each counts as one dependent.
4. **Given** a member added in September, **When** September and October are billed, **Then** they are not on September's bill and are on October's.
5. **Given** a member removed in September, **When** September and October are billed, **Then** they are on September's bill and not on October's.
6. **Given** a member whose class changes and who gains a dependent in September, **When** September and October are billed, **Then** September uses the old class and tier, and October uses the new class and tier.
7. **Given** a draft bill for a month, **When** a change that affects that month is made, **Then** the draft is recalculated. A finalised bill never changes.
8. **Given** a member whose class and tier has no rate, **When** the bill is generated, **Then** the member is listed as unpriced, and the bill cannot be finalised until the rate exists.
9. **Given** a client admin, **When** they open billing, **Then** they see their own company's bills and lines only.

---

### Edge Cases

- **Company number or company name:**
  - A company number longer than 20 characters, or a company name longer than 120 characters, is refused at onboarding.
- **Person already registered:**
  - A person already registered in another company (same ID type and number) is refused, and the other company is not named to a company-scoped user.
  - The same ID in two companies in the current data: every record in the set is held for NALICO to resolve (User Story 4, scenario 5).
- **Import and migration data problems:**
  - An existing value longer than the new column size is held as an exception, with the field and its length. It is never truncated.
  - A value the BHI model requires is missing, from migration or bulk import: the record is not loaded, is recorded as an exception for its company, and HR fixes it through bulk import. That member has no card access until fixed.
- **Contacts shared between members:**
  - The same email or phone on members of two companies: the multi-company message is shown after verification.
  - The same contact twice within one company: the member chooses their record after verification.
- **Dependents and tiers:**
  - A dependent added and removed within the same month does not change that month's or the next month's tier. Only dependents active at the start of the billing month count.
  - A member with more than 20 dependents is billed at the "more than two" rate. There is no cap.
- **Billing timing and rates:**
  - A bill generated late (for example on the 5th) still reflects the position at the start of the month. Changes made from the 1st onwards go to next month.
  - A company-specific rate with an effective date in the middle of a month applies from the first bill whose month starts on or after that date.
  - A rate edited after it was used by a finalised bill: the finalised bill keeps the rate it used, and the change applies to later bills only.
- **Classes and ages:**
  - All single-character class codes are used up: adding another class is refused (ClassCode is Text(1), at most 36 letter and digit codes).
  - A member with no date of birth: the age-65 check cannot run for them, so they are listed on an HR report instead of being deactivated.
- **Users and offboarding:**
  - A client admin tries to remove the company's last active admin: refused.
  - An offboarded company's users try to sign in: refused. The company's records remain readable to NALICO.

## Requirements *(mandatory)*

### Functional Requirements

**Data model**

- **FR-001**: All client companies' data MUST be held in one database and one set of tables. Companies are kept apart logically, not by separate databases or schemas.
- **FR-002**: The database MUST contain all 18 tables in Key Entities (8 in Group A, 10 in Group B). No table may be omitted.
- **FR-003**: Column names, data sizes and required flags MUST match Key Entities.
- **FR-004**: Primary keys, unique keys and indexes MUST match Key Entities, including the documented deviations.
- **FR-005**: The relationships R1 to R8 MUST be enforced as listed, including their update and delete behaviour.
- **FR-006**: Auto-numbered keys MUST be generated automatically and be unique across the whole platform.
- **FR-007**: A person (ID type plus ID number) MUST be a member of at most one company on the platform. An attempt to add them to a second company MUST be refused. The refusal MUST NOT name the other company to a company-scoped user.
- **FR-008**: Group B tables MUST be created as standalone tables, with no foreign keys added.

**Segregation and access**

- **FR-009**: Every company-owned record MUST be traceable to exactly one company:
  - Company, Member, BillingRun, BillingLine, CompanyBillingRule and company-specific PremiumRates rows carry CompanyNumber directly.
  - Dependent and Beneficiary rows trace through their Member.
  - Import table rows trace through their import batch (Platform level).
  - Class and standard PremiumRates rows are shared reference data for all companies.
- **FR-010**: Company-scoped users (the client admin and the users it creates) MUST reach only their own company's records, in every screen, API, report, export and import. A request for another company's record MUST get the same response as a record that does not exist.
- **FR-011**: Segregation MUST NOT rely on each feature remembering to filter. For a company-scoped user, a read that omits the company condition MUST still return only their company's rows.
- **FR-012**: The super admin role (today's platform administrator) is the only role with read and write access to every company. Super admin accounts are granted only to NALICO staff who need them, and only a super admin can create another. The platform MUST always keep at least one active super admin, because only a super admin can onboard companies. Super admins MUST be able to read and change every company's records, and MUST be able to run lists, dashboards and reports across all companies in one result, with each row labelled by company.
- **FR-013**: There MUST be no admin role between one company and every company. Each company is reachable only by its own company-scoped users (client admins and HR administrators), super admins, and the support and auditor roles. Companies that belong to one client, such as the six Beharry companies, are separate companies, each with its own client admin. *(Changed 2026-09-29: the group admin role and client groups were removed; see "Decision: no group admin" under Assumptions.)*
- **FR-014**: Support and auditor roles MUST keep their current read-only access to every company. They MUST NOT be able to create, change, deactivate or reactivate any record.
- **FR-015**: Access rules MUST be enforced by the server on every request. Hiding a screen or menu item is not the control.
- **FR-016**: The employee card lookup MUST match by email or phone across every active company:
  - Before verification, the response MUST be the same, and take the same time, for no match, one match or several (Constitution Principle I).
  - After verification with one match: the card is shown.
  - Several matches in one company: the member chooses their record.
  - Matches in two or more companies: no card is shown; the employee sees "Your details were found in more than one company. Please contact your HR department.", with no company named; an alert is recorded for super admins to resolve.
  - A company-scoped user sees only a flag on their own member that the contact is shared, never the other company.

**Onboarding and user management**

- **FR-017**: A super admin MUST be able to onboard a company without a code release. Onboarding creates the Company record and one client admin login for that company, and is all-or-nothing.
- **FR-018**: A client admin MUST be able to create, edit, deactivate and reactivate users of its own company, and reset their access:
  - It MAY grant only company-scoped roles (client admin, HR administrator), scoped to its own company.
  - It MUST NOT create or change platform, group, support or auditor users, or users of another company.
  - A company MUST always keep at least one active client admin.
- **FR-019**: Offboarding MUST set the company and its users inactive and exclude the company from the card lookup and billing, keeping every record. No record may be deleted (Constitution Principle III).
- **FR-020**: Onboarding, offboarding and every user change MUST write an audit entry with actor, action, company, before and after values, reason, timestamp and source address.

**Classes and rate card**

- **FR-021**: Classes MUST be shared by all companies. Classes A, B and C MUST be loaded initially. super admins MUST be able to add a class without a code release, and to retire and reactivate one. A class is retired by setting Active = false, never deleted, and a retired class cannot be chosen for new assignments.
- **FR-022**: Each class MUST have four tiers, identified by DependentBand:

  | DependentBand | CoverageBand | CoverageLabel | Active dependents |
  |---|---|---|---|
  | 0 | EE | Employee only | 0 |
  | 1 | EE+1 | Employee +1 | 1 |
  | 2 | EE+2 | Employee +2 | 2 |
  | 3 | EE+3+ | Employee + more than two | 3 or more |

  A class MUST NOT be assignable to a member until a rate exists for all four tiers.
- **FR-023**: A member's tier MUST be worked out from the number of their active dependents. Every dependent MUST count the same, whatever the relationship. There MUST be no cap on dependents.
- **FR-024**: The rate card MUST be held in PremiumRates:
  - A standard rate (no CompanyNumber) applies to every company.
  - A company-specific rate (with CompanyNumber) for a class and tier replaces the standard rate for that company only, from its effective date.
  - At launch, only standard rates exist.
- **FR-025**: Super admins MUST be able to edit rates by adding a rate with a new effective date. Earlier rates MUST be kept. A rate used by a finalised bill MUST NOT be changed in place.
- **FR-026**: Client admins and HR users MUST be able to view the rates that apply to their own company, and MUST NOT be able to change classes or rates.
- **FR-027**: Every class and rate change MUST write an audit entry with actor, class, company (if any), tier, before and after values, effective date, reason and timestamp.

**Monthly billing**

- **FR-028**: The system MUST produce one billing run per company per calendar month, with one billing line per member covered at the start of that month.
- **FR-029**: The bill for month M MUST reflect each member's coverage, class and active dependents as they stood at the start of M, whenever the bill is generated. Additions, removals, class changes and dependent changes made during M MUST take effect from the start of M+1.
- **FR-030**: Each billing line MUST record the member, class, active dependent count, tier, the rate used (PremiumRateID and its effective date), and the total, company and employee premiums.
- **FR-031**: The rate for a line MUST be the company-specific rate for that company, class and tier with the latest effective date on or before the start of M. If there is none, it MUST be the standard rate chosen the same way.
- **FR-032**: The company and employee split MUST be taken from the chosen rate's CompanyPremium and EmployeePremium. If an active CompanyBillingRule covers that company at the start of M, the split MUST instead be the rule's percentages of TotalPremium, rounded to the cent, and any rounding difference goes to the employee share.
- **FR-033**: A class change or dependent change for any member, in any company, MUST cause that member's premium to be recalculated for the next bill. Any draft bill for an affected month MUST be recalculated.
- **FR-034**: A billing run MUST go from Draft to Final. A Final run and its lines MUST NOT change. A run MUST NOT be finalised while any member is unpriced.
- **FR-035**: Super admins MUST be able to generate, recalculate and finalise bills for one company or for all companies. Client admins MUST be able to view and export their own company's bills.
- **FR-036**: Generating, recalculating and finalising a bill MUST each write an audit entry.

**Moving the existing data**

- **FR-037**: The system MUST migrate the data in the current tables into the BHI tables in the same database, using a documented column mapping.
- **FR-038**: Status MUST map as follows. The BHI Active flag, with InactiveDate and InactiveReason, becomes the only status.

  | Current status | Active | InactiveDate | InactiveReason |
  |---|---|---|---|
  | ACTIVE | true | empty | empty |
  | SUSPENDED | false | date of the change (from the audit log), otherwise the migration date | "Suspended" followed by the recorded reason, if any |
  | REMOVED | false | removal date | "Removed: " followed by the removal reason |
  | ARCHIVED (legacy) | false | archive date | "Archived: " followed by the archive reason |

- **FR-039**: Current data with no column in the BHI model MUST NOT be migrated. This covers employee number, employment status, the separate member status value, the archive and removal columns (beyond what FR-038 carries), and current record identifiers. Each dropped field MUST be listed in the column mapping, so the loss is documented and signed off.
- **FR-040**: A record missing a value the BHI model requires, or with a value too long for its column, MUST NOT be loaded, filled with a placeholder or silently dropped. It MUST be recorded in ImportException against its company, with the reason and the required action. Cut-over MUST NOT wait for these records.
- **FR-041**: A company's HR MUST be able to see their own company's exceptions and supply the missing values through bulk import. A corrected member MUST be loaded with their held dependents and beneficiaries, and the exception marked resolved.
- **FR-042**: Bulk import MUST reject any row missing a value the BHI model requires, record it in ImportException against its company, and show it to HR to correct and upload again.
- **FR-043**: Every existing reference to a member elsewhere (card sessions, change requests, policies, verification sessions) MUST resolve to the same person after migration. Audit log entries MUST NOT be altered.
- **FR-044**: The migration MUST produce a per-company, per-table reconciliation of source, loaded and held counts, with no personal data in the report.
- **FR-045**: Existing tables the BHI model does not have MUST be kept as separate platform tables. This covers admin users, roles and permissions, change requests and their documents, card sessions, verification sessions, policy memberships, app event logs and audit logs.
- **FR-046**: After cut-over the old tables MUST remain read-only until sign-off. They are then archived, not deleted.
- **FR-047**: Existing features MUST keep working after cut-over, with these changes:
  - Card eligibility uses Active = true.
  - Removing a member sets Active = false with a required reason; reactivating sets Active = true. Both are recorded in EnrollmentStatusHistory and the audit log.
  - The age-65 check sets Active = false with InactiveReason "Aged out at 65".
  - Features built on dropped fields (editing employment status, filtering by suspended) are removed or reworked.
  - Search and display by employee number use ID number or MemberID instead.
- **FR-048**: Migration rehearsals outside production MUST use synthetic or de-identified data.

### Key Entities *(include if feature involves data)*

Types are described as in the Access file: Auto number, Integer, Small integer, Text(n), Long text, Money (15,2), Decimal number, Yes/No, Date/Time, Binary. "Req" means required (not null).

#### Group A — Tables in the relationships diagram

**Relationships**

| # | Parent (1) | Child (many) | Linked column | On update of parent key | On delete of parent |
|---|---|---|---|---|---|
| R1 | Company | Member | CompanyNumber | cascade | restrict |
| R2 | Company | BillingRun | CompanyNumber | cascade | restrict |
| R3 | BillingRun | BillingLine | BillingRunID | cascade | cascade (delete lines) |
| R4 | Member | Dependent | MemberID | cascade | restrict |
| R5 | Member | Beneficiary | MemberID | cascade | restrict |
| R6 | Class | Member | ClassCode | cascade | restrict |
| R7 | Class | PremiumRates | ClassCode | cascade | restrict |
| R8 | Company | PremiumRates | CompanyNumber (optional; deviation D3) | cascade | restrict |

**Company** — client employer. PK: CompanyNumber. Index: Active.

| Column | Type | Req |
|---|---|---|
| CompanyNumber | Text(20) | Yes |
| CompanyName | Text(120) | Yes |
| Address1 | Text(120) | |
| Address2 | Text(120) | |
| City | Text(80) | |
| ContactName | Text(100) | |
| ContactPhone | Text(50) | |
| ContactEmail | Text(100) | |
| Active | Yes/No | Yes |
| Notes | Long text | |
| CreatedAt | Date/Time | |
| UpdatedAt | Date/Time | |

**Class** — employee category / plan tier. PK: ClassCode.

| Column | Type | Req |
|---|---|---|
| ClassCode | Text(1) | Yes |
| ClassName | Text(50) | Yes |
| Description | Text(255) | |
| Active | Yes/No | Yes |
| SortOrder | Integer | |

**Member** — insured employee. PK: MemberID. Unique: (IDType, IDNumber). Indexes: Active, ClassCode, CompanyNumber.

| Column | Type | Req |
|---|---|---|
| MemberID | Auto number | Yes |
| IDType | Text(20) | Yes |
| IDNumber | Text(40) | Yes |
| CompanyNumber | Text(20) → Company | Yes |
| LastName | Text(80) | Yes |
| FirstName | Text(80) | Yes |
| MiddleInitials | Text(20) | |
| DateOfBirth | Date/Time | |
| Sex | Text(10) | |
| ClassCode | Text(1) → Class | Yes |
| AddressLine1 | Text(150) | |
| AddressLine2 | Text(150) | |
| Phone | Text(50) | |
| Email | Text(100) | |
| EmploymentDate | Date/Time | |
| PlanDate | Date/Time | |
| RateOfPay | Money (15,2) | |
| Occupation | Text(100) | |
| Active | Yes/No | Yes |
| InactiveDate | Date/Time | |
| InactiveReason | Long text | |
| Notes | Long text | |
| CreatedAt | Date/Time | |
| UpdatedAt | Date/Time | |

**Dependent** — family member covered under a member. PK: DependentID. Indexes: Active, (IDType, IDNumber), MemberID.

| Column | Type | Req |
|---|---|---|
| DependentID | Auto number | Yes |
| MemberID | Integer → Member | Yes |
| IDType | Text(20) | |
| IDNumber | Text(40) | |
| DependentFullName | Text(120) | Yes |
| DateOfBirth | Date/Time | |
| Sex | Text(10) | |
| Relationship | Text(30) | Yes |
| Active | Yes/No | Yes |
| InactiveDate | Date/Time | |
| InactiveReason | Long text | |
| Notes | Long text | |
| CreatedAt | Date/Time | |
| UpdatedAt | Date/Time | |

**Beneficiary** — person who receives the benefit payout. PK: BeneficiaryID. Indexes: Active, (IDType, IDNumber), MemberID.

| Column | Type | Req |
|---|---|---|
| BeneficiaryID | Auto number | Yes |
| MemberID | Integer → Member | Yes |
| IDType | Text(20) | |
| IDNumber | Text(40) | |
| BeneficiaryFullName | Text(120) | Yes |
| DateOfBirth | Date/Time | |
| Sex | Text(10) | |
| Relationship | Text(30) | |
| Phone | Text(50) | |
| Email | Text(100) | |
| SharePercent | Decimal number | |
| Active | Yes/No | Yes |
| InactiveDate | Date/Time | |
| InactiveReason | Long text | |
| Notes | Long text | |
| CreatedAt | Date/Time | |
| UpdatedAt | Date/Time | |

**PremiumRates** — the rate card. A row with no CompanyNumber is a standard rate; a row with a CompanyNumber is that company's own rate (deviations D1–D2). PK: PremiumRateID. Unique: (CompanyNumber, ClassCode, CoverageBand, EffectiveDate). Index: Active.

| Column | Type | Req |
|---|---|---|
| PremiumRateID | Auto number | Yes |
| CompanyNumber | Text(20) → Company (deviation D1) | |
| ClassCode | Text(1) → Class | Yes |
| CoverageBand | Text(20) | Yes |
| CoverageLabel | Text(80) | Yes |
| DependentBand | Small integer | Yes |
| TotalPremium | Money (15,2) | Yes |
| CompanyPremium | Money (15,2) | Yes |
| EmployeePremium | Money (15,2) | Yes |
| EffectiveDate | Date/Time | Yes |
| Active | Yes/No | Yes |
| Notes | Long text | |
| CreatedAt | Date/Time | |

**BillingRun** — header of a billing run. PK: BillingRunID. Index: (CompanyNumber, BillingMonth).

| Column | Type | Req |
|---|---|---|
| BillingRunID | Auto number | Yes |
| CompanyNumber | Text(20) → Company | Yes |
| BillingMonth | Date/Time | Yes |
| BillingDate | Date/Time | Yes |
| GeneratedAt | Date/Time | |
| GeneratedBy | Text(80) | |
| Status | Text(20) | |
| Notes | Long text | |

**BillingLine** — one member line within a billing run. PK: BillingLineID. Indexes: (IDType, IDNumber), MemberID, BillingRunID.

| Column | Type | Req |
|---|---|---|
| BillingLineID | Auto number | Yes |
| BillingRunID | Integer → BillingRun | Yes |
| MemberID | Integer | Yes |
| IDType | Text(20) | Yes |
| IDNumber | Text(40) | Yes |
| MemberName | Text(180) | Yes |
| CompanyNumber | Text(20) | Yes |
| ClassCode | Text(1) | Yes |
| ActiveDependentCount | Integer | Yes |
| CoverageBand | Text(20) | Yes |
| CoverageLabel | Text(80) | Yes |
| TotalPremium | Money (15,2) | Yes |
| CompanyPremium | Money (15,2) | Yes |
| EmployeePremium | Money (15,2) | Yes |
| RateEffectiveDate | Date/Time | Yes |
| PremiumRateID | Integer | |
| CreatedAt | Date/Time | |

#### Group B — Tables NOT in the relationships diagram

These tables exist in the Access file with no relationship to any other table. They MUST be created as standalone tables, with no foreign keys added. Each row traces to its company through the import batch (Platform level).

**CompanyBillingRule** — company/employee cost-share percentages. PK: CompanyBillingRuleID. Unique: (CompanyNumber, EffectiveDate).

| Column | Type | Req |
|---|---|---|
| CompanyBillingRuleID | Auto number | Yes |
| CompanyNumber | Text(20) | Yes |
| CompanySharePercent | Decimal number | Yes |
| EmployeeSharePercent | Decimal number | Yes |
| EffectiveDate | Date/Time | Yes |
| Active | Yes/No | Yes |
| Notes | Long text | |
| CreatedAt | Date/Time | |

**EnrollmentStatusHistory** — log of activation/deactivation changes. PK: StatusHistoryID. Indexes: EffectiveDate, (EntityType, EntityID), MemberID.

| Column | Type | Req |
|---|---|---|
| StatusHistoryID | Auto number | Yes |
| EntityType | Text(20) | Yes |
| EntityID | Integer | Yes |
| MemberID | Integer | |
| CompanyNumber | Text(20) | |
| PersonIdentifier | Text(100) | |
| PersonName | Text(180) | Yes |
| OldActive | Yes/No | Yes |
| NewActive | Yes/No | Yes |
| EffectiveDate | Date/Time | Yes |
| Reason | Long text | Yes |
| CascadeApplied | Yes/No | Yes |
| RelatedRecordsChanged | Integer | |
| ChangedAt | Date/Time | |
| ChangedBy | Text(100) | |
| Notes | Long text | |

**SourceWorkbookArchive** — imported Excel files as received. PK: ArchiveID.

| Column | Type | Req |
|---|---|---|
| ArchiveID | Auto number | Yes |
| SourceOrdinal | Integer | Yes |
| FileName | Text(255) | Yes |
| FilePath | Long text | |
| FileSize | Integer | Yes |
| SHA256 | Text(64) | Yes |
| WorkbookBinary | Binary | |
| ImportedAt | Date/Time | |
| InventoryCellSHA256 | Text(64) | |
| SheetCount | Integer | |
| UsedCellCount | Integer | |
| NonBlankCellCount | Integer | |

**SourceWorkbookSheet** — sheets of imported workbooks. PK: SourceSheetID. Index: (SourceOrdinal, SheetIndex).

| Column | Type | Req |
|---|---|---|
| SourceSheetID | Auto number | Yes |
| SourceOrdinal | Integer | Yes |
| SheetIndex | Integer | Yes |
| SheetName | Text(100) | Yes |
| UsedRange | Text(40) | |
| RowCount | Integer | |
| ColumnCount | Integer | |
| UsedCellCount | Integer | |
| NonBlankCellCount | Integer | |

**RawEnrollmentRow** — source rows before cleanup. PK: RawRowID. Index: (SourceOrdinal, SheetIndex, SourceRow).

| Column | Type | Req |
|---|---|---|
| RawRowID | Auto number | Yes |
| SourceOrdinal | Integer | Yes |
| SheetIndex | Integer | Yes |
| SheetName | Text(100) | Yes |
| SourceRow | Integer | Yes |
| EntityType | Text(30) | |
| DataBearing | Yes/No | Yes |
| NormalizationStatus | Text(64) | |
| IssueSummary | Long text | |
| RowPayloadJson | Long text | |
| ImportedAt | Date/Time | |

**RawEnrollmentCell** — source cells before cleanup. PK: RawCellID. Index: (SourceOrdinal, SheetIndex, SourceRow, SourceColumn).

| Column | Type | Req |
|---|---|---|
| RawCellID | Auto number | Yes |
| SourceOrdinal | Integer | Yes |
| SheetIndex | Integer | Yes |
| SheetName | Text(100) | Yes |
| SourceRow | Integer | Yes |
| SourceColumn | Integer | Yes |
| CellAddress | Text(20) | |
| HeaderText | Text(255) | |
| HeaderOccurrence | Integer | |
| ValueKind | Text(20) | |
| RawText | Long text | |
| RawNumber | Decimal number | |
| FormulaText | Long text | |
| IsBlank | Yes/No | Yes |
| CellPayloadJson | Long text | |
| ImportedAt | Date/Time | |

**ImportException** — rows that could not be imported cleanly. PK: ExceptionID. Index: (SourceFile, SheetName, ExcelRow).

| Column | Type | Req |
|---|---|---|
| ExceptionID | Auto number | Yes |
| SourceAlias | Text(255) | |
| SourceFile | Text(255) | |
| SourcePath | Long text | |
| SheetName | Text(100) | |
| ExcelRow | Integer | |
| CellOrRange | Text(255) | |
| EntityType | Text(30) | |
| PersonName | Text(255) | |
| MemberIdentifier | Text(100) | |
| ReasonCodes | Long text | |
| Reason | Long text | |
| RequiredAction | Long text | |
| RawRowSummary | Long text | |
| CreatedAt | Date/Time | |

**ImportAdjustment** — values changed during import. PK: AdjustmentID (text, not auto number). Index: (SourceFile, SheetName, ExcelRow).

| Column | Type | Req |
|---|---|---|
| AdjustmentID | Text(20) | Yes |
| SourceAlias | Text(255) | |
| SourceFile | Text(255) | |
| SourcePath | Long text | |
| SheetName | Text(100) | |
| ExcelRow | Integer | |
| CellOrRange | Text(255) | |
| EntityType | Text(30) | |
| PersonName | Text(255) | |
| MemberIdentifier | Text(100) | |
| AdjustmentCode | Text(64) | |
| FieldName | Text(100) | |
| OriginalValue | Long text | |
| NormalizedValue | Long text | |
| Explanation | Long text | |
| CreatedAt | Date/Time | |

**ImportReconciliation** — pass/fail checks after an import. PK: ReconciliationID.

| Column | Type | Req |
|---|---|---|
| ReconciliationID | Auto number | Yes |
| MetricName | Text(100) | Yes |
| ExpectedValue | Text(255) | |
| ActualValue | Text(255) | |
| Passed | Yes/No | Yes |
| Details | Long text | |
| CheckedAt | Date/Time | |

**ImportDocumentation** — notes about the import process. PK: DocumentationID.

| Column | Type | Req |
|---|---|---|
| DocumentationID | Auto number | Yes |
| Topic | Text(100) | |
| Detail | Long text | |
| CreatedAt | Date/Time | |

#### Platform level (outside the 18 BHI tables)

- **Existing tables the BHI model does not have** (FR-045): admin users, roles and permissions, change requests and their documents, card sessions, verification sessions, policy memberships, app event logs and audit logs. Tables that point at a member refer to Member.MemberID.
- **Import batch**: one row per bulk import or migration run, holding the company number, who ran it and when. It is how each import table row traces to its company (FR-009). The 10 Group B tables are left exactly as given. For each run, the system issues:
  - a SourceOrdinal, which links SourceWorkbookArchive, SourceWorkbookSheet, RawEnrollmentRow and RawEnrollmentCell;
  - a SourceFile name, which links ImportException and ImportAdjustment.

  Both are unique across the platform. ImportReconciliation and ImportDocumentation have neither column, so each of their rows is linked to its batch by ID.
- **Import exception resolution**: which ImportException rows HR has resolved, by whom, when, and the member the fix created (FR-041).
- **Multi-company lookup alert**: one row each time an email or phone number matches members in more than one company. It holds the masked contact, the companies and members matched, when it was raised, and whether it was resolved, by whom and how.
- **Roles**:
  - **Super admin**: today's platform administrator, with every company (FR-012).
  - **Client admin**: one company, and manages its users (FR-018).
  - **HR administrator**: one company.
  - **Support and auditor**: every company, read-only (FR-014).

#### Deviations from the Access file

These are the only intended differences from the Access model. Each is needed by a client requirement.

| # | Table | Change | Why |
|---|---|---|---|
| D1 | PremiumRates | Adds CompanyNumber (Text(20), optional, → Company). A blank value means a standard rate. | Premiums must become company-specific (client requirement, FR-024) |
| D2 | PremiumRates | Unique key becomes (CompanyNumber, ClassCode, CoverageBand, EffectiveDate), with a blank CompanyNumber treated as one value | A company rate and the standard rate can share class, tier and date |
| D3 | Relationships | Adds R8: Company → PremiumRates on CompanyNumber, cascade on update, restrict on delete | Follows from D1 |

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A structural comparison against Key Entities shows 18 of 18 tables and zero differences in columns, sizes, required flags, keys, indexes and relationships, other than deviations D1 to D3.
- **SC-002**: A super admin can onboard a company and issue its client admin login in under 5 minutes, without a code release.
- **SC-003**: Automated segregation tests covering every screen's API, report, export and import find zero cases of a company-scoped user reading or changing another company's data. This includes tests that deliberately omit the company filter.
- **SC-004**: For every company and table, migrated plus held records equal the source count, and every held record is visible to its own company's HR on the first day after cut-over.
- **SC-005**: For a test month covering additions, removals, a class change, a new dependent, 0 to 7 dependents, a standard-rate company and a company-rate company, 100% of billing lines match a hand calculation to the cent.
- **SC-006**: Existing application features pass their current acceptance tests after cut-over.
- **SC-007**: For a sample of migrated members covering every current status, card access after cut-over matches card access before in 100% of cases (held members excluded).
- **SC-008**: A super admin can add a new class with its four tier rates in under 5 minutes, and it can be assigned straight away.
- **SC-009**: In lookup tests, 100% of contacts matching members in two or more companies show the "contact your HR" message after verification, show no card, and raise an alert. The response before verification is identical to the no-match and single-match cases.
- **SC-010**: A client admin can create an HR user for their company in under 2 minutes, and automated tests show zero cases of a client admin creating or changing a user outside their company or above their role.
- **SC-011**: A bill for all companies for one month is produced in under 5 minutes for 5,000 members.

## Assumptions

- "Client" in the requirements means a client company. NALICO is the insurer and operates the platform. Super admins (today's platform administrator role, renamed) are the only users who see and change all companies. Support and auditor keep read-only access to all companies. Every other admin sees only their own company (confirmed 2026-09-29).
- **Decision: no group admin (2026-09-29).** An earlier reading of "one admin login per client" added a group admin role scoped to a client group (the six Beharry companies). The product owner decided against it: the super admin is the only role above one company, and every company has its own admin portal login. The group admin role (`ROLE_HR_GROUP_ADMIN`), `admin_users.group_scope`, the `client_groups` table and the `/v1/admin/groups` routes were removed; migration `004_remove_group_admin.sql` deletes any group admin accounts (their past actions stay in the activity log).
- **Decisions of 2026-09-30** (billing and import review):
  - **Coverage band codes** are the client's: EMP_ONLY, EMP_PLUS_1, EMP_PLUS_2, EMP_PLUS_3PLUS (DependentBand 0-3; band = min(active dependants, 3)). Migration 006 renamed the earlier EE codes, final bills included; only the code and label changed.
  - **Draft bills recalculate automatically** after a change that can move them (FR-033): members added, deactivated, reactivated or reclassed; dependants added, deactivated or reactivated; imports; rates, billing rules and classes; the retirement sweep. A draft is replaced only when its lines would change. Final bills never change.
  - **A billing rule's shares total 100**, held by the database (migration 007). The company pays round(total x CompanySharePercent / 100) and the employee the remainder, which is EmployeeSharePercent of the total to the cent.
  - **A class is assignable** only when its four standard rates are in force by the first month a member given it now is billed (the 1st of next month).
  - **Date of birth is required for a new member**, by hand or by import (an import row without one is held, MISSING_DATE_OF_BIRTH), and cannot be cleared. Existing members without one are flagged on the dashboard and filterable in the members list.
  - **Import exceptions**: a corrected row resolves a held member row whether the member is new or already on file, and a held dependant or beneficiary row too. Any held record can be marked resolved by hand with a note (migration 008 records the method and note).
- One person is a member of one company only (confirmed 2026-09-29).
- Classes are shared by all companies. Rates are standard for all companies today, and company-specific rates are added later in the same PremiumRates table (confirmed 2026-09-29, and client requirement "rates going forward").
- The 10 import tables stay exactly as given, and their company is recorded through the import batch (confirmed 2026-09-29).
- The start of a billing month is 00:00 on the 1st in Guyana time (UTC−4).
- The CompanyBillingRule percentages, when present, override the rate card's company and employee split (FR-032). This is an interpretation. The Access file has both, and the client did not say which wins.
- Billing produces the amounts. Invoicing, payment collection, credit notes and corrections to finalised bills are not part of this feature.
- Naming style (e.g. snake_case) is decided in the plan. The Access forms, reports, queries and VBA module are not part of this feature.
- R3 (deleting a billing run deletes its lines) is kept as in the model. It is not exposed as an action. Finalised runs are never deleted, and draft runs are recalculated in place.
- The multi-company lookup message comes after verification, not before (Constitution Principle I, confirmed 2026-09-29). The current "No record found" reply before verification is replaced by the same response a match gets.
- The distinction between suspended and removed survives only as the text in InactiveReason.
- The existing HR administrator role becomes a company-scoped role that the client admin can grant. Existing Beharry HR users keep their current company.

## Out of Scope

- Invoicing, payments, collections, credit notes and adjustments to finalised bills.
- The full Excel import pipeline that fills the raw workbook, sheet, row and cell tables. Only the tables are created. Bulk import is in scope only for the BHI required-field checks and exception fixing (FR-041, FR-042).
- Separate databases or schemas per company.
- Physical deletion of any record, company or old table.
