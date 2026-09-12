# Integrations

## Purpose

Normalize Zomato, Swiggy and future provider orders.

## Current implementation

Domain functionality is not implemented. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- Provider payload types stay inside provider adapters.
- Unique provider/external-order ID prevents duplicate acceptance.
- Persist external-to-internal item/modifier mappings and surface unmapped items for resolution.
- Mock/manual input is allowed until API access exists; internet-dependent ingestion cannot continue during WAN outage.

## Proposed entities / database tables

provider_orders, provider_item_mappings, provider_modifier_mappings, processing records. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Calls Orders through normalized application contract; Menu mappings.

## Pending work

Provider interfaces, mocks, authenticated ingestion, deduplication and retry policy; real APIs later.
