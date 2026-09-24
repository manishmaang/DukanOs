# DukanOS Agent Instructions

This repository contains **DukanOS**, a restaurant POS, kitchen, order, customer, credit, reporting, and online-order management system.

This file defines the mandatory working rules for AI coding agents working in this repository.

---

## 1. Primary Rule

Do not begin coding immediately.

Before making changes, understand the current system using the repository documentation and existing implementation.

Repository documentation is persistent project memory and must be kept synchronized with the code.

---

## 2. Mandatory Context Loading

Before starting ANY task:

1. Read `docs/SYSTEM.md`.
2. Identify which module or modules are affected.
3. Read the corresponding files from:

```text
docs/modules/
```

4. Read `docs/ARCHITECTURE.md` when the task affects:
   - architecture
   - module boundaries
   - infrastructure
   - communication between modules
   - application structure

5. Read `docs/DATABASE.md` when the task affects:
   - database tables
   - columns
   - relationships
   - indexes
   - constraints
   - transactions
   - migrations

6. Read `docs/DECISIONS.md` before making significant architectural or domain-design decisions.

7. Inspect the actual existing code related to the task.

Do not rely only on conversation history.

Do not assume documentation is enough without inspecting the implementation.

---

## 3. Source of Truth Priority

When information conflicts, use this order:

```text
1. Explicit current user requirement
2. Existing working implementation
3. docs/SYSTEM.md
4. Relevant module documentation
5. docs/ARCHITECTURE.md / docs/DATABASE.md
6. docs/DECISIONS.md
7. Previous conversation context
```

If code and documentation disagree, investigate why.

Do not silently choose one.

Correct the inconsistency as part of the task when appropriate.

---

## 4. Documentation Is Part of the Task

A development task is NOT complete until the relevant documentation is updated.

After implementation:

### Always consider updating

```text
docs/SYSTEM.md
docs/modules/<affected-module>.md
docs/CHANGELOG.md
```

### Update when relevant

```text
docs/ARCHITECTURE.md
docs/DATABASE.md
docs/DECISIONS.md
```

---

## 5. SYSTEM.md Rules

`docs/SYSTEM.md` describes the CURRENT system.

It should contain:

- system purpose
- current modules
- major workflows
- major business rules
- system relationships
- technology stack
- important constraints
- implementation status
- known limitations
- pending major work

Do not turn `SYSTEM.md` into a historical log.

Remove obsolete information when the system changes.

Historical changes belong in `CHANGELOG.md`.

Architectural reasoning belongs in `DECISIONS.md`.

---

## 6. Module Documentation

Each substantial module should have its own file:

```text
docs/modules/
```

Examples:

```text
auth.md
users.md
menu.md
orders.md
payments.md
kitchen.md
customers.md
credit.md
reports.md
integrations.md
```

Create a new module document when a meaningful new domain module is introduced.

Each module document should normally contain:

```text
# Module Name

## Purpose
## Responsibilities
## Entities
## Database Tables
## APIs
## Business Rules
## State / Lifecycle
## Dependencies
## Events Produced
## Events Consumed
## Permissions
## Important Edge Cases
## Current Implementation
## Pending Work
## Important Decisions
```

Only include sections that provide useful information.

Avoid meaningless boilerplate.

---

## 7. Implementation Principles

DukanOS should remain a **modular monolith** unless there is a documented reason to change that architecture.

Prefer:

- simple designs
- explicit business logic
- strong typing
- database integrity
- transactions
- proper constraints
- auditability
- testability
- maintainability

Avoid unnecessary:

- microservices
- Kafka
- distributed systems
- abstraction layers
- premature optimization
- generic frameworks built before they are required

---

## 8. Business Logic Placement

Business rules must live in backend/domain/application logic.

Do not rely on frontend-only validation for important rules.

Examples:

- payment calculations
- refund calculations
- credit limits
- order status transitions
- amendments
- queue prioritization
- inventory rules
- permissions

Frontend validation may improve UX but must not be the only protection.

---

## 9. Database Rules

Use PostgreSQL as the source of persistent truth.

Always use migrations for schema changes.

Never modify production database structures manually.

Use appropriate:

- foreign keys
- unique constraints
- check constraints
- indexes
- transactions
- row locking when required
- idempotency protections where required

Financial values must use precise decimal/numeric types.

Never use floating-point values for money.

---

## 10. Financial Integrity

Financial operations require special care.

Never silently overwrite financial history.

Changes such as:

- additional payments
- refunds
- credit purchases
- credit settlements
- order amendments
- cancellations

must remain auditable.

Reports must reflect the final business result while preserving transaction history.

Critical financial logic must have tests.

---

## 11. Order Integrity

Orders are the core operational record.

Do not destroy historical order information when orders are modified.

Important actions should maintain history, including:

- item replacement
- quantity changes
- item removal
- price adjustments
- cancellation
- refund
- queue priority changes
- payment changes

---

## 12. Kitchen Rules

The digital system is the kitchen's source of truth.

Paper tokens are optional output only.

Kitchen logic should support:

- FIFO queueing
- explicit prioritization
- preparation status
- ready status
- real-time updates
- aggregated production requirements

Production aggregation must never remove the relationship between quantities and their originating orders.

---

## 13. Concurrency

Assume multiple devices operate at the same time.

Possible actors include:

- cashier
- kitchen
- dispatch
- manager
- owner

Protect against:

- duplicate payments
- duplicate status transitions
- simultaneous conflicting edits
- duplicate order acceptance
- multiple workers processing the same operation

Use backend and database-level protections.

Do not rely only on UI state.

---

## 14. External Integrations

Zomato, Swiggy, and future integrations must be isolated behind provider-specific adapters.

External provider models must not leak throughout the core domain.

Normalize external orders into the DukanOS internal order model.

Example:

```text
External Provider
        ↓
Provider Adapter
        ↓
Normalized Order
        ↓
DukanOS Order System
```

---

## 15. Testing Expectations

Prioritize testing of business-critical behavior.

Especially test:

- totals
- channel pricing
- amendments
- refunds
- additional payments
- credit ledger
- status transitions
- queue ordering
- kitchen aggregation
- permission boundaries
- concurrency-sensitive operations

Do not prioritize trivial tests while financial or order-state logic remains untested.

---

## 16. Scope Discipline

When implementing a requested task:

- change only what is necessary
- avoid unrelated refactors
- do not rewrite working modules without reason
- do not introduce new architecture casually
- reuse existing project patterns where appropriate

If a larger refactor is genuinely necessary, explain why before performing it.

---

## 17. Architectural Decisions

Record significant decisions in:

```text
docs/DECISIONS.md
```

Examples:

- changing module boundaries
- selecting a new persistence strategy
- introducing Redis
- changing authentication strategy
- introducing background jobs
- introducing an event bus
- changing order amendment semantics

Include:

```text
Decision
Context
Options considered
Chosen approach
Reason
Consequences
Date
```

Do not record trivial implementation details as architectural decisions.

---

## 18. Changelog

Update:

```text
docs/CHANGELOG.md
```

after meaningful changes.

Entries should be concise.

Example:

```text
## 2026-09-12

### Added
- Kitchen production aggregation endpoint.
- Real-time kitchen queue updates.

### Changed
- Order amendments now preserve original item history.

### Fixed
- Duplicate READY transitions under concurrent requests.
```

---

## 19. Before Completing Any Task

Verify:

```text
[ ] Relevant context files were read
[ ] Existing code was inspected
[ ] Implementation matches existing architecture
[ ] Business rules are enforced server-side
[ ] Database integrity is preserved
[ ] Critical logic has tests
[ ] Existing tests pass
[ ] New migrations are valid
[ ] Relevant module docs are updated
[ ] SYSTEM.md is updated if necessary
[ ] DATABASE.md is updated if necessary
[ ] ARCHITECTURE.md is updated if necessary
[ ] DECISIONS.md is updated if necessary
[ ] CHANGELOG.md is updated
[ ] No obsolete documentation remains
[ ] For frontend work: mobile, tablet portrait, tablet landscape and desktop tested
[ ] Touch targets are appropriate; no hover-only critical actions
[ ] No unintended page-level horizontal scrolling; primary actions remain accessible
[ ] Actual workflows completed at responsive sizes, including dialogs and keyboard-constrained heights
[ ] Responsive browser regression coverage and visual review updated
```

---

## 20. Session Continuity

Assume every new coding session may start with zero conversational memory.

Therefore:

```text
Repository documentation = persistent memory.
```

At the beginning of every task:

```text
Read context
    ↓
Inspect implementation
    ↓
Understand affected modules
    ↓
Implement
    ↓
Test
    ↓
Update documentation
    ↓
Verify consistency
```

Do not skip this workflow even for apparently small changes if they affect domain behavior.

---

## 21. Final Response After a Coding Task

When finishing a task, summarize:

1. What changed.
2. Which files were changed.
3. Which database changes/migrations were introduced.
4. Which tests were added or run.
5. Which documentation files were updated.
6. Any remaining limitations or follow-up work.

Keep the summary concise and factual.

---

## 22. GitHub Delivery After Every Completed Change

The user has authorized committing and pushing every completed major or minor achievement to:

```text
git@github.com:manishmaang/DukanOs.git
```

After each completed change:

1. Run checks appropriate to the change and synchronize documentation.
2. Review the diff and staged files; never commit secrets, local environment files, database data, dependencies, or generated build output.
3. Commit the completed work with a descriptive message.
4. Push to the current module/work branch and verify the remote commit; follow section 23 before merging completed work into main.
5. Report the commit and any push failure in the final response.

This is standing authorization; do not request permission again for routine commits and pushes. Preserve remote history and reconcile concurrent changes before pushing. Never force-push or discard someone else's work without explicit authorization. If authentication, connectivity, or branch protection blocks delivery, retain the local commit and report the concrete blocker.

---

## 23. Separate Branch for Every Module

Every new module or separately scoped module milestone must use its own branch, always created from updated main. Do not start new module implementation directly on main or branch from another unfinished module. Use descriptive names such as `feature/menu-management`; use `fix/<scope>` or `chore/<scope>` for independently scoped fixes or workflow changes.

Before creating a new work branch:

1. Inspect Git status and preserve any unrelated/uncommitted work. Never discard it to switch branches.
2. Fetch origin, switch to main, and update it with a fast-forward-only pull. If local main has diverged, reconcile the history without force-pushing or discarding commits.
3. Create the new branch from that updated main, then perform the documentation/context-loading workflow before implementation.
4. Push the branch with an upstream. Commit and push each completed major or minor achievement to that branch under section 22.

When the module/milestone is complete:

1. Finish relevant tests, documentation, and diff review. Do not merge unfinished module work merely because an intermediate achievement was pushed.
2. Fetch the latest main and reconcile any changes into the work branch; resolve conflicts and rerun affected checks when necessary.
3. Push the verified work branch, update local main, and merge the completed branch using a merge commit (`--no-ff`) so module boundaries remain visible in history.
4. Push main and verify the remote commit. If branch protection requires a PR, follow that workflow instead of bypassing protection.
5. Always create the next module branch afresh from updated main, never by reusing the previous module branch.

The user has given standing authorization for this branch, commit, push, and completed-module merge workflow. No additional routine confirmation is required. Report authentication, connectivity, conflicts needing user input, or branch-protection blockers accurately.


## 24. Responsive and Touch UX Is a Core Requirement

DukanOS must work on inexpensive phones, tablets and touch screens. No operational workflow may require a desktop. Before implementing ANY frontend feature or modifying an existing screen, determine during initial design how it works on phone, tablet portrait, tablet landscape, desktop/laptop and touch-only devices. Responsive support is not a later polish phase.

Read and follow [docs/RESPONSIVE_UI.md](docs/RESPONSIVE_UI.md). Preserve usable touch targets (at least 44×44px, preferably 48px for operational actions), readable text, visible focus, keyboard access, no hover-only controls, no page-level horizontal scrolling, reachable primary actions and clean long-text wrapping. Adapt dialogs and scrolling to available dynamic viewport/keyboard space. Verify actual workflows, not just rendering, at the prescribed device classes and review screenshots. Frontend work is incomplete until the responsive checklist above passes.

Every frontend completion summary must report **Responsive behavior: Mobile, Tablet (portrait and landscape), Desktop**, the workflows/browser sizes tested and any real-device/browser limitations. Future screens must follow this rule from their first design. Do not add device-specific backend business logic.

## 25. Bill and Refund Integrity

A Bill is the commercial tab; each child Order is an independent Kitchen preparation round. Never reopen completed Kitchen tokens to add food. Payments attach to Bills and are append-only. Changing a bill total in a future amendment must preserve original payments and derive new amount_due or refund_due. Customer refunds are **CASH ONLY from Counter**, even when original collection was UPI; no UPI refund or Kitchen/Dispatch refund workflow unless the user explicitly changes this rule. Do not implement arbitrary refunds without legitimate amendment-derived entitlement and transaction/concurrency tests.
