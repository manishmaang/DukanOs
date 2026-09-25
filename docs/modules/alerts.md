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

Mounted POS/Bills reminder and Kitchen timer components poll every two seconds, including running background tabs where the browser permits, plus focus/online/visibility refresh. ServerTime anchors a monotonic browser display clock; one-second renders derive countdowns from due timestamps. Known snapshots are cached in per-user sessionStorage (memory still works when cache writes fail). Reload with a reachable backend discovers durable state; a new login/device does not need this cache. Explicit signout clears alert caches; a 401/403 alert response also clears its cached projection.

Failed polls keep known schedules ticking, marked Offline / server unavailable. Reminder amounts are explicitly last-synced values, not new financial assertions. No reminder snooze or timer mutation is enabled while disconnected, and the backend remains authoritative for every write. A successful poll replaces the entire snapshot, removing paid/closed reminders and acknowledged/cancelled timers, including those resolved on another device. Clock samples are resynchronized. No offline writes are queued.

The alert tray is nonblocking and sticky within the POS menu pane or above Bill detail; its summary shows due count, with expandable bounded scrolling details. Timer controls stay in a separate compact Kitchen strip; existing Order/Production grids remain intact.

## Limits

An already open frontend can continue known alerts during backend failure. A fresh login or full app reload while authentication/backend is unavailable is not guaranteed to open an authenticated workspace. Closed/suspended browser pages cannot guarantee timely rendering or background alarms; this is an in-app alert system, not an OS alarm service. Reopening with the server available discovers overdue state. Polling propagation is roughly two seconds plus request latency/timeouts, not instantaneous. LAN/server/PostgreSQL must be available to persist any change. Physical Android/iOS keyboard/background behavior requires device smoke testing. No push, reminders outside POS, timer editing, generic scheduler, amendments or refunds are implemented.

## Verification — 2026-09-25

`npm run check` passed, together with all 95 PostgreSQL integration tests. The new alert/payment suite covers atomic rollback, full Cash/UPI, split/partial and Pay Later, immutable round snapshots, changed-payable concurrency, idempotent receipts, reminder pause/resume/snooze, role unions, timer associations and concurrent acknowledgement. Existing Menu/POS, Kitchen, Dispatch, Bills and responsive browser suites passed.

The new Chromium touch suite passed Dine In multi-round/partial settlement and reminder workflows, full Cash/UPI, lost combined-confirmation response/reload/retry, plus associated 2-minute timers, reload/new-device discovery, custom timer cancellation, offline due alerts and cross-device reconciliation. Workflows ran at 390×844, 768×1024, 1024×768 and 1440×900; boundary layouts passed all eight required sizes and 390×420 constrained height. External traffic was blocked. Test fixtures advance stored timestamps only in isolated schemas to verify expiry without real-minute waits. Phone, portrait, landscape and desktop screenshots were reviewed; final refinements prevent reminder/input overlap and remove inherited minimum height from the timer strip.

Migration 013 was applied to the local development database. Before/after hashes verified all 23 existing tables, excluding only the intentional new permission grants and nullable payment-provenance column. Existing 13 orders, 11 bills, 2 payments, users, menu/image metadata and audits were preserved; no fake operational records were inserted. The restarted local application passed database readiness and unauthenticated protection checks on both alert read endpoints. Temporary artifacts are /tmp/dukanos-alerts-*; this verification is not a backup or physical-device certification.

## Secondary audible alerts

Visual alerts remain mandatory and authoritative. Web Audio generates local sine tones without assets, network calls or dependencies. On POS or Kitchen, tap **Enable Sound** (a real user gesture), then **Test sound** to check the device volume. **Sound: ON · Mute** stops audio only. The browser preference is stored in localStorage (`dukanos-sound-alerts`), never PostgreSQL; other devices retain their own preference. Tabs in the same browser storage partition share preference changes, but each running tab has its own coordinator and may sound. Each reload/login may require another activation gesture even when the preference is remembered. Failed/blocked activation leaves visual alerts working and offers retry. No new permission is introduced.

`operational-audio.ts` centralizes patterns, modest gain and cadence in AUDIO_POLICY:

- Payment: two gentle ascending notes (660/880 Hz), initially when due, then at most once every **60 seconds** while due.
- Kitchen: three short stronger beeps (880/880/1100 Hz), initially when due, then at most once every **20 seconds** while due.

One coordinator per authenticated app coalesces all due entries of a type into one pattern. It tracks identity plus deadline and a monotonic next-play time; two-second polls and POS/Bill component remounts do not restart the cadence. Another timer becoming due joins the next cycle, while all timers remain visible. Patterns never overlap; Kitchen wins if both types are eligible. In the current UI only the active workspace participates: POS uses bills.reminders.read, Kitchen uses kitchen.timers.read. Switching workspaces stops the old pattern, and logout disposes audio resources. No sound for new Kitchen order arrival is added.

Snooze/acknowledge/cancel immediately suppress the selected occurrence while the request is pending; failure restores eligibility. Successful direct Bill settlement suppresses its current reminder. Canonical polling removes resolved entries or installs the next persisted deadline. Other due entries still participate in later cycles. Test sound changes neither domain state nor due dates and respects the same non-overlap/cadence protection. Device media volume controls loudness; there is no separate volume slider.

Known deadlines keep driving visual/audio alerts during backend failure, with the existing offline indication. Reconnection replaces the snapshot, stopping resolved alerts and resynchronizing the clock. Sound never sends a request, acknowledges, snoozes, records payment, or queues an offline write. No focus check prevents background playback; browser throttling, suspension, silent modes, muted tabs and device volume can still prevent timely or audible output. A suspended/closed page cannot guarantee an alarm. Returning to the app discovers persisted overdue state and can sound when enabled/unlocked. This is compatible with future PWA work but adds no service worker or OS notification service.

### Physical-device smoke checklist (still required)

On Android phone/tablet Chrome and iPhone/iPad Safari where used:

- Log in; Enable Sound; Test the POS payment tone and Kitchen timer tone. Check media volume, silent mode and muted-tab settings.
- Create Dine In Pay Later with a short reminder; verify visual + tone, snooze, recurrence, then full settlement and silence across connected sessions.
- Create a one-minute microwave timer; verify visual + tone, 20-second recurrence, acknowledge and cancel; verify two simultaneous timers remain legible without overlapping patterns.
- Repeat in foreground, background tab, after screen lock/unlock, reload and app switching. Record delayed/suspended behavior; do not treat screen-locked alarms as guaranteed.
- Disconnect the backend after receiving a deadline, let it expire, resolve from another connected device and reconnect. Check that stale audio stops.
- Check sound controls with touch, portrait/landscape rotation and keyboard visible. Desktop emulation does not certify speakers or mobile OS behavior.

### Automated audio verification

`npm test` includes seven deterministic coordinator tests for lock/mute, repeats, poll deduplication, multi-alert serialization/priority, workspace scope, snooze/settlement, acknowledgement/cancellation (including pending/failing actions), known deadlines during outages and canonical removal. `npm run test:alerts-browser` instruments native Chromium Web Audio starts: blocked activation/retry, touch unlock/Test, no API mutations from Test, preference across reload, newly opened overdue sessions, two-note versus three-note patterns, no poll spam, a real 20-second repeat without a focus guard, offline expiry and cross-device resolution. It does not measure speaker output. Payment's 60-second cadence is verified with deterministic clock inputs.

For bounded runs, set `ALERT_BROWSER_WIDTH` to 390, 768, 1024 or 1440; run all four values to cover every touch workflow. Each run still checks all eight boundary sizes. Fixtures are isolated PostgreSQL schemas; external traffic is blocked and real restaurant records are never modified. Screenshots/logs are temporary artifacts under /tmp.

Audio delivery verification (2026-09-25): `npm run check` passed (17 frontend tests including seven audio tests), all 95 PostgreSQL integration tests passed, and Menu/POS, Kitchen, Dispatch, Bills and responsive browser regressions passed. All four alert/audio workflow shards passed, each including eight boundary sizes and 390×420 constrained height. Phone, portrait/landscape tablet and desktop screenshots were reviewed. The combined alert run hit the execution window; the four completed shards provide the full workflow coverage. Physical speaker/Android/iOS checks remain outstanding.
