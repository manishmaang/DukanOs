# Orders

## Purpose

Own the canonical order, item revisions, lifecycle, and audit history.

## Current implementation

Domain functionality is not implemented. The web app contains a placeholder route only. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- Proposed lifecycle: DRAFT → PLACED → QUEUED → PREPARING → READY → COMPLETED. CANCELLED is terminal; cancellation/amendment cutoffs need explicit business decisions.
- Per-item modifiers and free-text instructions persist with item snapshots.
- Replacements and quantity changes append audited revisions; reports use final effective items while retaining originals.
- Status changes and amendments require expected version/locking, authorization, and persisted idempotency.

## Proposed entities / database tables

orders, order_items, item revisions, amendments, order_status_history, idempotency records. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Menu, optional Customers, Payments/Credit; Kitchen and Reports consume order state.

## Pending work

Define transition matrix including cancellation/payment states; implement creation before amendments.
