# Operational reminders and Kitchen timers

## Purpose and boundaries

Persistent Dine In payment reminders belong to Bills; Kitchen timers are operational clocks independent of FIFO, production aggregation and order lifecycle. AlertsModule provides separate projections/commands using the existing PostgreSQL transaction helper and BillsService's live authorization/restaurant write lock. No cron worker, cloud push, external API or browser notification permission is required. Records are not a generic notification engine.

## Payment reminders

One bill_reminders row per DINE_IN bill stores interval_minutes (integer 1–1440), next_due_at, creation actor/time, last manual update actor, update time and version. Configuration is explicit in unpaid/open Bill detail, with 5/10/15-minute presets and custom minutes. It starts at server now + interval. No reminders are seeded or automatically enabled on every bill.

A nonnull next_due_at means active. A paid or closed bill has null next_due_at and is omitted from active reads. PostgreSQL triggers on order insertion, collection and closure synchronize this in the same business transaction. Partial payments retain the existing schedule. Paying in full pauses it immediately. An OPEN bill receiving a new unpaid round resumes its saved interval from the new server time; a same-transaction full collection pauses it again before commit. Closed bills cannot receive new rounds. No deleted reminder is resurrected; the preference row is retained. Automatic balance synchronization preserves the last manual updated_by actor (the payment/order itself retains its own audited actor).

The stored next_due_at anchors recurrence: occurrences are next_due_at + n × interval. Once due, the persistent visible alert remains until snooze or settlement and its occurrence count advances each interval. No background mutation, browser-originated firing event or infinite occurrence rows are needed. Every new device derives the same due/overdue state from absolute timestamps and serverTime. Snooze advances next_due_at by the configured interval from server now; expected version prevents concurrent stale snoozes from extending it again. Changing interval explicitly restarts the schedule. There is no reminder-delete/disable UI in this milestone.

## Kitchen timers

kitchen_timers stores UUID, label (trimmed 1–120 characters), duration_seconds (integer 60–86400), started_at, due_at, creator, idempotency key/hash, optional order/item FKs and resolution actor/time. due_at = started_at + duration. Optional item association must belong to the chosen QUEUED/PREPARING order; standalone labels are supported. Snapshot names are read from order_items, never current Menu. Timers can outlive their associated order leaving Kitchen; they remain until explicitly resolved.

Persisted state is ACTIVE → ACKNOWLEDGED or CANCELLED. DUE/OVERDUE is derived, never a delayed worker-written state. Acknowledgement requires server time >= due_at; cancellation is available earlier. Same terminal action repeated returns success without rewriting original actor/time. Opposite terminal action conflicts. The database rejects edits to timer identity/duration/timestamps, terminal rewrites/deletes, invalid item association and premature acknowledgement. Create uses actor-scoped request UUID/hash; retries return the original timer identity even after resolution. Wrong duration is corrected by cancelling and creating another timer, not editing elapsed time.

Kitchen has a compact timer strip with + Timer, 1/2/3/5-minute presets, custom minutes, optional active-order/item selectors and a label. Details disclose association; timer alerts do not become Production cards or alter aggregation. Finished timers visibly say TIMER DONE / OVERDUE until acknowledged or cancelled. No flashing, sound or device notification dependency.

## APIs and permissions

All paths begin /api, reject unexpected fields/query/body, use authenticated sessions and the existing mutation header.

| Route                                | Capability             | Input / result                                                                |
| ------------------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| GET /reminders/active                | bills.reminders.read   | serverTime, entries of active bill reminders including last authoritative due |
| POST /bills/:id/reminder             | bills.reminders.manage | intervalMinutes; configure/restart unpaid open Dine In schedule               |
| POST /bills/:id/reminder/snooze      | bills.reminders.manage | expected version in `version`; snooze by saved interval                       |
| GET /kitchen/timers                  | kitchen.timers.read    | serverTime, ACTIVE entries sorted due_at/id, including overdue                |
| POST /kitchen/timers                 | kitchen.timers.manage  | requestId, label, durationSeconds, optional orderId/orderItemId               |
| POST /kitchen/timers/:id/acknowledge | kitchen.timers.manage  | no body; acknowledge a due timer                                              |
| POST /kitchen/timers/:id/cancel      | kitchen.timers.manage  | no body; cancel active timer                                                  |

OWNER/MANAGER/CASHIER receive both bills.reminders capabilities; OWNER/MANAGER/KITCHEN receive both kitchen.timers capabilities. Pure KITCHEN never receives financial reminder data; pure CASHIER/DISPATCH cannot manage Kitchen timers. Operational role unions apply. Mutations recheck current session/capability after acquiring advisory lock 742019323, then domain rows. Reads use a consistent repeatable-read snapshot. No implicit role-name bypass.

## Freshness, fallback and reconciliation

Visible POS/Bills reminder and Kitchen timer components poll every two seconds, plus focus/online/visibility refresh. ServerTime anchors a monotonic browser display clock; one-second renders derive countdowns from due timestamps. Known snapshots are cached in per-user sessionStorage (memory still works when cache writes fail). Reload with a reachable backend discovers durable state; a new login/device does not need this cache. Explicit signout clears alert caches; a 401/403 alert response also clears its cached projection.

Failed polls keep known schedules ticking, marked Offline / server unavailable. Reminder amounts are explicitly last-synced values, not new financial assertions. No reminder snooze or timer mutation is enabled while disconnected, and the backend remains authoritative for every write. A successful poll replaces the entire snapshot, removing paid/closed reminders and acknowledged/cancelled timers, including those resolved on another device. Clock samples are resynchronized. No offline writes are queued.

The alert tray is nonblocking and sticky within the POS menu pane or above Bill detail; its summary shows due count, with expandable bounded scrolling details. Timer controls stay in a separate compact Kitchen strip; existing Order/Production grids remain intact.

## Limits

An already open frontend can continue known alerts during backend failure. A fresh login or full app reload while authentication/backend is unavailable is not guaranteed to open an authenticated workspace. Closed/suspended browser pages cannot guarantee timely rendering or background alarms; this is an in-app alert system, not an OS alarm service. Reopening with the server available discovers overdue state. Polling propagation is roughly two seconds plus request latency/timeouts, not instantaneous. LAN/server/PostgreSQL must be available to persist any change. Physical Android/iOS keyboard/background behavior requires device smoke testing. No sounds, push, reminders outside POS, timer editing, generic scheduler, amendments or refunds are implemented.

## Verification — 2026-09-25

`npm run check` passed, together with all 95 PostgreSQL integration tests. The new alert/payment suite covers atomic rollback, full Cash/UPI, split/partial and Pay Later, immutable round snapshots, changed-payable concurrency, idempotent receipts, reminder pause/resume/snooze, role unions, timer associations and concurrent acknowledgement. Existing Menu/POS, Kitchen, Dispatch, Bills and responsive browser suites passed.

The new Chromium touch suite passed Dine In multi-round/partial settlement and reminder workflows, full Cash/UPI, lost combined-confirmation response/reload/retry, plus associated 2-minute timers, reload/new-device discovery, custom timer cancellation, offline due alerts and cross-device reconciliation. Workflows ran at 390×844, 768×1024, 1024×768 and 1440×900; boundary layouts passed all eight required sizes and 390×420 constrained height. External traffic was blocked. Test fixtures advance stored timestamps only in isolated schemas to verify expiry without real-minute waits. Phone, portrait, landscape and desktop screenshots were reviewed; final refinements prevent reminder/input overlap and remove inherited minimum height from the timer strip.

Migration 013 was applied to the local development database. Before/after hashes verified all 23 existing tables, excluding only the intentional new permission grants and nullable payment-provenance column. Existing 13 orders, 11 bills, 2 payments, users, menu/image metadata and audits were preserved; no fake operational records were inserted. The restarted local application passed database readiness and unauthenticated protection checks on both alert read endpoints. Temporary artifacts are /tmp/dukanos-alerts-*; this verification is not a backup or physical-device certification.
