# Kitchen

## Purpose

Present digital queue and traceable production requirements.

## Current implementation

Domain functionality is not implemented. The web app contains a placeholder route only. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- Default FIFO ordered by queue timestamp and stable order ID; explicit priority needs actor, time, permission and reason.
- Main actions START (QUEUED → PREPARING) and READY (PREPARING → READY).
- Production groups by product/variant and retains per-order quantities and customization references.
- Reconnecting screens must refresh authoritative state; paper is optional.

## Proposed entities / database tables

Projection over orders/items; audited priority records. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Orders owns lifecycle and item history; future Socket.IO application notifications.

## Pending work

Queue APIs, large readable KDS, transition/aggregation/concurrency tests, reconnect behavior and WAN-outage verification.

## Orders Core integration

Orders Core is now available: GET /api/orders?status=QUEUED returns date/token, queuedAt, actor and snapshotted item/kitchen/variant names, quantities and instructions, sorted queued_at/id ascending with cursor paging. Omit date to include yesterday’s pending orders. KITCHEN has orders.read. No KDS UI/actions/events exist yet. The next milestone must implement audited Orders lifecycle commands and a migration replacing the current confirmed-order update guard; retain financial and line immutability.
