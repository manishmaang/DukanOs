# Customers

## Purpose

Maintain optional customer profiles and order relationships.

## Current implementation

Domain functionality is not implemented. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- Walk-in orders must not require registration.
- Support searchable normalized mobile, optional birthday/preferences/notes and communication consent.
- Do not make phone unique without deciding how shared numbers are handled.

## Proposed entities / database tables

customers; structured preferences/consent if needed. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Orders and Credit reference customer identity.

## Pending work

Profile CRUD/search, access controls and order history.
