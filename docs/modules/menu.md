# Menu

## Purpose

Manage products, portions, customizations, availability, and channel prices.

## Current implementation

Domain functionality is not implemented. The web app contains a placeholder route only. No domain APIs, migrations, or events exist for this module.

## Intended business rules

- One product with variants and per-channel prices; do not duplicate products for each provider.
- Orders snapshot product names/prices and item instructions; later menu changes cannot rewrite sales history.

## Proposed entities / database tables

categories, menu_items, item_variants, channel_prices, modifiers, item_modifiers. These are design candidates, not current schema. See [DATABASE](../DATABASE.md).

## Dependencies

Orders consumes menu through application services; Integrations maps external items.

## Pending work

Categories, items, variants, availability, modifiers and channel price migrations/APIs with exact-price validation.
