# Credit

## Purpose

Track customer receivables with a durable ledger.

## Current implementation

Domain functionality is not implemented. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- Eligibility and optional credit limits are enforced on the backend.
- Purchases increase outstanding balance; settlements reduce it and do not create sales.
- Posted ledger history is append-only; corrections are linked entries with actor and reason.
- Lock the customer credit account for competing purchases/settlements and enforce unique operation IDs.

## Proposed entities / database tables

credit_accounts, ledger_entries. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Customers, Orders, Payments; Reports derives aging and outstanding balances.

## Pending work

Eligibility, exact ledger rules, credit limits, settlement allocation, balances and concurrency tests.
