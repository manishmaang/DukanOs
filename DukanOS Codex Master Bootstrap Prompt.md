# DukanOS — Initial Project Bootstrap Instructions

You are the lead software engineer responsible for designing and building **DukanOS**, a restaurant/fast-food POS, kitchen, customer, credit, reporting, and online-order management system.

Your first responsibility is to establish a reliable repository structure and persistent context system so future AI coding sessions can understand the project without depending on previous conversations.

---

# 1. CONTEXT MANAGEMENT IS A CORE REQUIREMENT

This project will be developed across many sessions.

Conversation history must NOT be treated as persistent project memory.

The repository itself must contain enough current context for another developer or AI agent to understand the system.

Create:

```text
AGENTS.md

docs/
├── SYSTEM.md
├── ARCHITECTURE.md
├── DATABASE.md
├── DECISIONS.md
├── CHANGELOG.md
└── modules/
    ├── auth.md
    ├── users.md
    ├── menu.md
    ├── orders.md
    ├── payments.md
    ├── kitchen.md
    ├── customers.md
    ├── credit.md
    ├── integrations.md
    └── reports.md
```

Additional module documentation should be created as additional domain modules are introduced.

---

# 2. AGENTS.md

Create a root-level:

```text
AGENTS.md
```

This file is the mandatory operating guide for every AI coding agent working on DukanOS.

It must define:

- mandatory context-loading workflow
- documentation responsibilities
- source-of-truth priority
- development principles
- database rules
- financial integrity rules
- order-history requirements
- concurrency expectations
- testing expectations
- scope discipline
- architecture decision recording
- task completion checklist
- session continuity expectations

`AGENTS.md` must remain relatively concise.

Do NOT duplicate detailed system state inside it.

Its purpose is:

```text
AGENTS.md = HOW TO WORK
```

while:

```text
docs/SYSTEM.md = WHAT CURRENTLY EXISTS
docs/modules/*.md = HOW EACH DOMAIN MODULE WORKS
docs/DECISIONS.md = WHY IMPORTANT DECISIONS WERE MADE
```

Every future task must follow `AGENTS.md`.

---

# 3. MANDATORY FUTURE TASK WORKFLOW

The `AGENTS.md` you create must require future coding agents to perform this workflow:

```text
Read AGENTS.md
        ↓
Read docs/SYSTEM.md
        ↓
Identify affected modules
        ↓
Read relevant docs/modules/*.md
        ↓
Read ARCHITECTURE / DATABASE / DECISIONS when relevant
        ↓
Inspect actual implementation
        ↓
Implement
        ↓
Test
        ↓
Update documentation
        ↓
Verify consistency
```

A task is not complete until relevant documentation matches the implementation.

---

# 4. SYSTEM.md

`docs/SYSTEM.md` is the primary current-state context document.

Maintain:

- project purpose
- current architecture
- technology stack
- modules
- module relationships
- major workflows
- major business rules
- implementation status
- system constraints
- known limitations
- unresolved questions
- major pending work
- terminology

Keep the document current.

Do not turn it into a history log.

---

# 5. MODULE DOCUMENTATION

Each significant domain module must have its own documentation file.

Recommended structure:

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

Only keep useful information.

Do not generate empty boilerplate merely to fill sections.

---

# 6. ARCHITECTURE.md

Document:

- repository structure
- frontend/backend boundaries
- module boundaries
- dependency direction
- real-time communication
- external integrations
- shared libraries
- deployment assumptions
- infrastructure
- authentication flow
- important architectural patterns

Update this file whenever architecture changes.

---

# 7. DATABASE.md

Document the current PostgreSQL model.

For each important table record:

- purpose
- important columns
- primary key
- foreign keys
- unique constraints
- indexes
- important check constraints
- relationships
- financial semantics
- lifecycle considerations

Also document important transactional boundaries.

Database documentation must reflect migrations and actual implementation.

---

# 8. DECISIONS.md

Use this as a lightweight Architecture Decision Record.

For important decisions include:

```text
## Decision

Date:

### Context

### Options Considered

### Decision

### Reason

### Consequences
```

Examples of decisions worth recording:

- modular monolith architecture
- PostgreSQL choice
- WebSocket strategy
- order-amendment model
- payment model
- credit accounting model
- external-integration adapter pattern
- Redis introduction
- background jobs
- inventory architecture

Do not record trivial coding choices.

---

# 9. PROJECT PURPOSE

DukanOS replaces the shop's current paper-token-based ordering workflow.

Orders may originate from:

- counter
- Zomato
- Swiggy
- future external channels

The existing workflow generates:

1. receipt
2. kitchen token

The current system has major limitations:

1. Kitchen instructions such as spicy, less spicy, thick gravy, thin gravy, no vegetables, etc. cannot be recorded.
2. Orders cannot be correctly amended after billing.
3. Item changes cause incorrect product-sales reporting.
4. Additional payments/refunds are difficult to reconcile.
5. Kitchen tokens can be lost.
6. Newer orders may start before older orders.
7. Kitchen staff cannot see aggregated quantities that need preparation.
8. Customer information is not maintained.
9. Regular customers may buy on credit and settle later.
10. Zomato and Swiggy orders are not consolidated into the internal system.
11. Counter, Zomato, and Swiggy may have different prices.
12. Paper currently acts as the operational source of truth.

DukanOS must solve these problems.

---

# 10. CORE PRINCIPLE

There must be ONE centralized digital order record.

```text
Counter ─────┐
             │
Zomato ──────┼──→ Normalized Order System
             │
Swiggy ──────┘
                    │
                    ▼
               Kitchen Queue
                    │
                    ▼
                Preparing
                    │
                    ▼
                  Ready
                    │
                    ▼
            Dispatch / Served
                    │
                    ▼
                 Reports
```

Printed receipts and tokens may remain supported.

They must NOT be the canonical operational record.

---

# 11. TECHNOLOGY

Use:

## Backend

- Node.js
- NestJS
- TypeScript

## Frontend

- React
- TypeScript

## Database

- PostgreSQL

## Real-time Communication

- WebSocket / Socket.IO where appropriate

## Architecture

Use a **modular monolith** initially.

Do not introduce microservices, Kafka, or distributed architecture without a demonstrated requirement and documented decision.

---

# 12. REPOSITORY STRUCTURE

Design a monorepo unless project investigation shows a compelling reason not to.

A possible direction:

```text
apps/
├── api/
├── pos/
├── kitchen/
└── admin/

packages/
├── shared-types/
├── ui/
└── config/

docs/
```

Do not blindly use this layout.

Inspect project requirements and propose the final structure before scaffolding.

---

# 13. PRIMARY DOMAIN MODULES

Initial expected modules:

```text
Auth
Users
Menu
Orders
Payments
Kitchen
Customers
Credit
Reports
Integrations
```

Create additional modules only when meaningful domain boundaries appear.

---

# 14. AUTHENTICATION & USERS

Possible roles include:

```text
OWNER
MANAGER
CASHIER
KITCHEN
DISPATCH
```

Support:

- authentication
- authorization
- role-based permissions

Use configurable RBAC where practical.

Sensitive operations such as refunds, manual discounts, order cancellation, credit adjustments, and priority overrides may require elevated permissions.

---

# 15. MENU

Support:

- categories
- menu items
- variants / portions
- availability
- modifiers
- channel prices

Example:

```text
Veg Noodles

Regular
Half
Full
```

Channel pricing example:

```text
Veg Noodles Full

Counter ₹180
Zomato  ₹210
Swiggy  ₹215
```

Do not duplicate menu products solely because their platform prices differ.

---

# 16. ORDERS

Every order receives an internal identifier regardless of source.

Possible sources:

```text
COUNTER
ZOMATO
SWIGGY
MANUAL_ONLINE
```

Possible lifecycle:

```text
DRAFT
PLACED
QUEUED
PREPARING
READY
COMPLETED
CANCELLED
```

Maintain order-status history.

Orders should support:

- customer
- channel
- items
- variants
- quantities
- modifiers
- special instructions
- prices
- discounts
- taxes when applicable
- timestamps
- source identifiers
- audit information

---

# 17. ORDER ITEM CUSTOMIZATIONS

Each individual order item must support customization.

Examples:

```text
Extra spicy
Less spicy
No vegetables
No onion
No capsicum
Thick gravy
Thin gravy
Extra gravy
```

Also allow a free-text kitchen instruction.

Customizations must belong to specific order items rather than being stored only at the order level.

---

# 18. ORDER AMENDMENTS

Customers may change orders after billing.

Example:

```text
Original:
Noodles ₹120

Replacement:
Pasta ₹150

Additional payment:
₹30
```

Or:

```text
Original:
Pasta ₹150

Replacement:
Noodles ₹120

Refund:
₹30
```

Do not overwrite financial history.

Maintain an audit trail of the original order and subsequent amendments.

Reports should reflect actual final items sold without destroying transaction history.

---

# 19. PAYMENTS

Initially support:

```text
CASH
UPI
CARD
CREDIT
```

Allow multiple payments when needed.

Example:

```text
₹300 UPI
₹50 Cash
```

Support:

- payments
- additional payments
- refunds
- credit purchases
- later credit settlements

Never use floating-point arithmetic for money.

Use PostgreSQL numeric/decimal values and safe application-level money handling.

---

# 20. KITCHEN DISPLAY SYSTEM

Kitchen operations must use a digital KDS.

Example:

```text
#121
Waiting: 12m

Noodles Full ×1
Manchurian Half ×1

EXTRA SPICY
```

Kitchen interactions should remain extremely simple.

Main actions:

```text
START
READY
```

The kitchen interface should emphasize:

- large readable text
- minimal interactions
- real-time updates
- clear waiting time
- clear special instructions

---

# 21. QUEUE MANAGEMENT

Default preparation order should follow FIFO unless business rules justify another approach.

Manual prioritization must require permission and a reason.

Possible reasons:

```text
RIDER_WAITING
CUSTOMER_WAITING
PREVIOUS_ERROR
MANAGER_DECISION
```

Record:

- who prioritized
- when
- why

Do not allow silent queue manipulation.

---

# 22. PRODUCTION AGGREGATION

Kitchen requires two perspectives.

## Order View

```text
#101
Noodles ×1

#102
Pasta ×1
Biryani ×1

#103
Noodles ×1
Biryani ×1
```

## Production View

```text
Noodles ×2
Biryani ×2
Pasta ×1
```

Variants must remain distinct:

```text
Noodles

Regular ×2
Half ×3
Full ×5
```

Special instructions must remain traceable.

Example:

```text
Full ×5

#105 → No vegetables
#109 → Extra spicy
```

Aggregation must never lose association with source orders.

---

# 23. CUSTOMERS

Customer profiles may contain:

- name
- mobile
- birthday
- preferences
- notes
- order history
- consent/preferences for communication

Do not require customer registration for every order.

Phone numbers should be searchable.

---

# 24. CREDIT CUSTOMERS

Some regular customers purchase now and pay later.

Use a ledger.

Example:

```text
Customer: Rajesh

Sep 01 Order        +₹500
Sep 05 Order        +₹300
Sep 10 Payment      -₹400

Outstanding         ₹400
```

Support:

- credit eligibility
- optional credit limits
- outstanding balances
- transaction history
- repayments
- aging
- notes

A credit sale counts as a sale when the order occurs.

Later payment reduces receivables and must not be counted as another sale.

---

# 25. ONLINE ORDER INTEGRATIONS

Zomato, Swiggy, and future platforms must use provider adapters.

Example:

```text
Integrations
├── ZomatoAdapter
└── SwiggyAdapter
```

Normalize provider payloads into the internal DukanOS order model.

Maintain mappings for:

- provider order ID
- internal order ID
- external item
- internal item
- external modifier
- internal modifier

Initially allow mocked/manual integration if API access is unavailable.

Core order logic must not depend directly on Zomato or Swiggy payload structures.

---

# 26. REPORTING

Eventually support:

- total sales
- order count
- channel sales
- item sales
- portion sales
- payment-method sales
- refunds
- credit sales
- outstanding credit
- hourly sales
- busiest periods
- preparation time
- delayed orders
- cancellations
- amendments
- top-selling dishes
- customer history

Financial reports must follow correct accounting semantics.

---

# 27. AUDITABILITY

Preserve important history.

Examples:

- order amendments
- cancellations
- refunds
- manual price changes
- priority overrides
- payment adjustments
- credit adjustments

Store where relevant:

```text
performed_by
performed_at
reason
old_value
new_value
```

Prefer append-only historical records for important events.

---

# 28. CONCURRENCY

Assume simultaneous operation by:

```text
Cashier
Kitchen
Dispatch
Manager
Owner
```

Protect against:

- duplicate payments
- duplicate order transitions
- conflicting order changes
- duplicate preparation actions
- inconsistent financial state

Use database transactions, constraints, locking, and idempotency where appropriate.

Do not rely on frontend state for concurrency safety.

---

# 29. REAL-TIME EVENTS

Possible application events include:

```text
order.created
order.updated
order.queued
order.preparing
order.ready
order.completed

kitchen.queue.updated

payment.created

credit.updated
```

Expose stable application-level events.

Do not expose database internals directly to clients.

---

# 30. PRINTING

Support thermal printing through an abstraction.

Potential documents:

```text
Customer Receipt
Kitchen Token
Credit Receipt
Refund Receipt
```

Printing failure must never cause order loss.

Digital order state remains authoritative.

---

# 31. SECURITY

At minimum implement:

- secure password hashing
- authentication
- authorization
- DTO validation
- RBAC
- protected administrative endpoints
- safe environment handling
- no secrets in source control
- audit logs for sensitive actions
- rate limiting where useful

---

# 32. ERROR HANDLING

Use standardized business errors.

Examples:

```text
ORDER_ALREADY_COMPLETED
INVALID_ORDER_TRANSITION
ITEM_NOT_AVAILABLE
CREDIT_LIMIT_EXCEEDED
INVALID_REFUND
DUPLICATE_PAYMENT
```

Do not expose raw database errors or stack traces to frontend clients.

---

# 33. DEVELOPMENT PHASES

Develop incrementally.

## Phase 1 — Foundation

- repository structure
- documentation
- PostgreSQL setup
- migrations
- authentication
- roles
- menu
- variants
- channel pricing

## Phase 2 — POS

- order creation
- modifiers
- payments
- order lifecycle
- printing abstraction

## Phase 3 — Kitchen

- KDS
- real-time queue
- FIFO
- production aggregation

## Phase 4 — Amendments

- item changes
- additional payments
- refunds
- audit history

## Phase 5 — Customers

- profiles
- preferences
- history

## Phase 6 — Credit

- ledger
- settlements
- balances
- aging

## Phase 7 — Reports

- owner dashboard
- sales
- products
- payment reports
- kitchen analytics
- credit reports

## Phase 8 — External Integrations

- provider abstraction
- Zomato
- Swiggy
- item mapping

Do not attempt to implement every phase simultaneously.

---

# 34. INITIAL TASK

For the first repository session:

1. Read these requirements carefully.
2. Propose the final repository structure.
3. Define domain/module boundaries.
4. Design the initial PostgreSQL model.
5. Identify important state machines.
6. Identify transactional boundaries.
7. Identify concurrency-sensitive operations.
8. Create `AGENTS.md`.
9. Create the `/docs` structure.
10. Create `SYSTEM.md`.
11. Create `ARCHITECTURE.md`.
12. Create `DATABASE.md`.
13. Create `DECISIONS.md`.
14. Create `CHANGELOG.md`.
15. Create initial module documentation.
16. Scaffold the backend/frontend structure.
17. Configure linting, formatting, testing, and environment handling.
18. Add an initial README.
19. Run the project/tests to verify the scaffold.
20. Update documentation to match what was actually created.

Do NOT implement the complete restaurant system during this first task.

Stop after the architecture, context system, and reliable application scaffold are established.

Then provide a concise summary containing:

- repository structure
- chosen architecture
- modules
- major database entities
- important design decisions
- files created
- commands needed to run the system
- recommended next implementation task

From all future tasks onward, follow `AGENTS.md` as the persistent repository instruction set.