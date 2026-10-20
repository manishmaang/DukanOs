# Real-shop workflows — proposed deployment review

Local implementation passed the checks recorded in the checkpoint; see [checkpoint](../checkpoints/real-shop-workflows.md). This document is not deployment authorization. The agent has not connected to AWS, applied migrations, restarted services or modified production. Do not rerun historical test-data cleanup or restaurant seeds. EventBridge scheduling remains separate and paused.

## Prerequisites

Review the final verified commit and this migration with the owner. Capture a fresh encrypted database/uploads backup and verify it is restorable using the established runbook. Record production deployed commit, migration ledger, menu/item/variant/settings/audit counts and financial order/item/payment/report counts. Record pending QUEUED/PREPARING/READY rounds and currently active timers. Do not invent current production counts from historical handovers.

## Coordinated upgrade (owner authorization required)

Use the existing maintenance/deployment procedure in DEPLOYMENT.md. Stop API writes during migration/release replacement to avoid mixing old clients and new serving commands. Apply forward migration 022 through the normal migration command/maintenance identity, including updated runtime grants. No data seed or cleanup command is part of this release. Build/deploy matching frontend/API/schema artifacts and restart normally. Ask staff to refresh open clients. Brief downtime is required for the coordinated release; measure migration duration on a production-sized restored copy before scheduling.

The migration adds serving and fulfillment tables, capability grants and lifecycle/serving/timer guards. Existing PREPARING/READY histories remain intact. It does not rewrite menu, snapshots, payments or reports. The owner-approved previous-day rule completes partly served Dine-In at the configured cutoff, retaining full sale value; fully unserved prior-day cancellation remains unchanged.

## Smoke tests

- Health/readiness matches the deployed migration ledger; no disabled protection triggers/unvalidated foreign keys.
- Compare all preexisting row counts/checksums, excluding only explicitly expected permission and migration metadata changes. Confirm names, prices, images, balances, payments and saved reports remain unchanged.
- KITCHEN and DISPATCH see Kitchen; CASHIER alone cannot serve. Old Dispatch URL safely redirects only for authorized users.
- Dine-In quantity 3: serve 1, refresh another device, verify 2 pending and accurate production; correction requires reason. Serve remainder; round completes, Bill settlement remains independent.
- Parcel handover refuses unpaid/refund-due Bill; after legitimate settlement it completes in one real history event. Do not fabricate production payments for testing.
- Verify active legacy PREPARING/READY rounds remain visible; platform handover has no Counter financial effect.
- Two consecutive POS confirmations yield separate independent Bills unless Add Round was explicitly selected. Success notice does not block entry; failed requests preserve draft/retry identity.
- Phone/tablet/desktop cart scrolling, long notes, Kitchen controls, timers, reminders and availability remain usable.
- Monitor the next real cutoff for system completion/cancellation evidence and unchanged financial values. Do not advance production clocks to test this.

## Rollback

No destructive down migration is provided. Before any new serving/fulfillment writes, a failed rollout can be investigated while writes remain stopped; old API startup will reject a mismatched migration ledger, so switching binaries alone is not a valid rollback. Prefer a reviewed forward fix.

After new writes, restoring an older backup loses those transactions and is not an acceptable routine rollback. Stop writes, preserve current evidence/backup, and obtain owner-approved recovery or forward-fix instructions. Never drop serving evidence, rewrite history, or reverse applied migrations manually to make an old release start.
