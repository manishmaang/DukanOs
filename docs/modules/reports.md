# Reports

## Purpose

Present sales, payments, receivables, and kitchen performance consistently.

## Current implementation

Domain functionality is not implemented. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- Final effective items drive product sales; history remains queryable.
- Separate sales, collected tenders, refunds, credit sales and later repayments.
- Define business day/timezone and cancellation/refund date treatment before financial reporting.

## Proposed entities / database tables

No independent authoritative tables initially. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Read projections from Orders, Payments, Credit, Customers and Kitchen timestamps.

## Pending work

Owner dashboard and reconciled report queries/tests after source workflows exist.
