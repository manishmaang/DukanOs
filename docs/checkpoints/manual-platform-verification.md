# Manual platform orders V1 verification

All fixtures are disposable PostgreSQL schemas and local browser/media fixtures. Existing restaurant data, credentials and schema were not migrated or rewritten. SMTP was disabled except local test fixtures; no AWS or provider service was contacted.

## Automated evidence

- Full PostgreSQL integration: **232 passed, 0 failed, 0 skipped**. Includes 19 new platform subtests plus their parent and all existing regressions.
- `npm run check`: lint, TypeScript, **16 API unit tests + 18 frontend unit tests**, production API/web builds and formatting passed. The final platform card presentation is also built and browser-tested.
- `npm audit --omit=dev`: **0 vulnerabilities** at every severity; no dependency changes.
- Production web build retains the existing warning about a JavaScript chunk above 500 kB. No build errors.
- **11 browser suites passed, 0 failed** in their final runs: Menu, Responsive, Kitchen, Dispatch, Bills, Alerts, Amendments, Reports, Expenses, Daily Reports and Platform. The new Platform suite includes four complete touch workflows plus five additional boundary/short-height checks.

## Requested scenario coverage

The request's numbered cases are consolidated into transactional and browser tests, not 60 separately named tests.

| Requested cases                                  | Actual coverage                                                                                                                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–10 creation, identity and financial separation | Platform integration creates both sources and Counter, duplicate/same-cross-source references, request retries/conflicts, bill/source database rejection, unchanged bill/payment/refund records.                                                          |
| 11–22 serving definitions and snapshots          | Normal/Reduced, all discount classifications, explicit mixed selections, g/ml, missing profiles, invalid amounts/precision/unit, stale review and historical name/size changes; Production source/profile separation.                                     |
| 23–30 Kitchen                                    | Shared FIFO, START/READY, exact aggregate portion counts, snapshot/source grouping in integration; browser badges, sizes and instructions; existing Kitchen suite covers lateness, timers and FIFO regression.                                            |
| 31–36 Dispatch                                   | Bill-less READY reads and handover, reference/specification display, Counter Takeaway settlement gate, duplicate completion and cancellation/completion race.                                                                                             |
| 37–43 cancellation/cleanup                       | Audited QUEUED/PREPARING/READY cancellation, attached timer cancellation, no financial effects, terminal rejection, before/at-cutoff/current-day exclusions and repeat-safe system cleanup. Browser cancellation through tracking at four device classes. |
| 44–50 finance                                    | Before/after Dashboard/report financial equality (excluding read timestamp), immutable Daily Report financial equality, unchanged collections/refunds/balances; full existing Counter amendments/refunds and report regressions.                          |
| 51–56 security                                   | Cashier creation/cancellation, Kitchen and Dispatch capability separation, operational Menu-edit denial, strict DTO/unknown-field rejection, direct database invariants, runtime role/schema readiness/authentication/HTTPS proxy regressions.            |
| 57–60 responsive                                 | Four complete Menu-edit/POS/Kitchen/Production/Dispatch/tracking/cancellation touch workflows, eight width classes plus constrained height across platform/existing suites; screenshots visually reviewed.                                                |

## Responsive behavior

Mobile 390×844, Tablet portrait 768×1024, Tablet landscape 1024×768 and Desktop 1440×900 run complete new workflows. Platform boundary/dialog checks also cover 360×800, 430×932, 1280×800, 1600×900 and 390×420. Existing suites retain their eight-size matrix. Browser fixtures block external traffic. Visual review covers readable source badges, serving sizes, portion counts, mobile review scrolling, landscape serving controls, portrait Production and desktop POS cards. Real Android/iOS keyboards, touch hardware and assistive technologies remain physical-device checks.

## Regression fixture corrections

Migration preservation comparisons exclude only newly introduced nullable fields while still comparing every original value. The new 020 preservation test migrates populated Counter orders/payments/menu/users/audit and checks original records remain identical. Auth expectations include the explicitly granted platform capabilities. Reports historical settlement fixtures complete their food before rollover, because unfinished historical food is now intentionally cancelled by the existing 05:00 policy. No production rule was weakened to make fixtures pass.

## Scope and limitations

Migration 020 must be reviewed/backed up/applied to the intended restaurant database in a separately authorized operation. Menu administrators must enter actual serving definitions; no example quantities are seeded. Counter measured profiles, provider APIs, platform settlements, operational source analytics and audited external-reference replacement are deferred. Cancelled references remain reserved; do not add fabricated suffixes to bypass duplicate protection. Unsent platform drafts are memory-only; uncertain submissions retain the exact retry request in sessionStorage, and durable reference uniqueness also prevents duplicate orders. A physical-device restaurant smoke test remains necessary before real usage.
