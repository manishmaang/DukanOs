# Payments

## Purpose

Record tenders, additional payments, and refunds without losing financial history.

## Current implementation

Domain functionality is not implemented. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- Initial tenders: CASH, UPI, CARD; CREDIT is receivable financing rather than collected cash.
- Allow split tender. Use numeric money and exact decimal application arithmetic.
- Refunds reference original transactions and cannot exceed remaining refundable value.
- Never count credit settlements as new sales; external gateway confirmation is not implied by recording a tender.

## Proposed entities / database tables

payment_transactions, refunds; payment/provider attempt state if an actual gateway is added. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Orders and Credit share atomic financial operations.

## Pending work

Resolve tax/discount/rounding policy; implement exact arithmetic and audited/idempotent tender/refund workflows with critical tests.
