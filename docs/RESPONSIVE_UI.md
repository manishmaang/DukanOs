# Responsive and touch UI standard

Responsive and touch support is a core DukanOS requirement. Operational workflows must never require a desktop. This standard applies to all routes, forms, dialogs, error/success states and future screens during initial design.

## Devices and layout

- Phones: 360–599px; one operational card per row where necessary, readable quantities and full-width primary actions. POS uses a persistent View Order entry and a modal cart rather than placing the cart after the entire menu.
- Tablet portrait: 600–899px; keep readable cards, use focused single-pane editing when two panes would squeeze controls.
- Tablet landscape: 900–1199px; POS menu/cart side by side where usable; Kitchen reduces columns naturally.
- Laptop/desktop: 1200px and wider; preserve approved dense grids and wide editors, without stretching text unnecessarily.
- Viewports describe CSS pixels, not device brands. Support orientation changes without clearing drafts or requiring rotation.

POS and Kitchen primarily target landscape tablets with phone fallback. Dispatch targets phones/tablets. Menu and staff administration primarily target tablets/desktops and must remain fully usable on phones. Future owner/report views must support all classes.

## Touch, navigation and accessibility

Interactive targets must provide at least 44×44 CSS pixels, preferably 48px for frequent operational actions. Checkbox/radio labels count as their touch area; tiny glyphs alone do not. Give adjacent actions space. Nothing important may depend on hover. Use native buttons, associated labels, keyboard-operable controls and visible focus rings. Workspace navigation must not become confusing wrapped rows; use a compact accessible selector on narrow screens and expanded links on wide screens. Permission filtering and multi-role navigation remain unchanged.

Keep primary text at readable sizes and input text at least 16px to avoid mobile input zoom. Wrap long dish/category/staff/variant names; never truncate critical instructions. Convey availability/late/error status with text as well as color. No rapid flashing; honor reduced motion for any future animation. Focus must remain inside modal dialogs and return to an appropriate opener on dismissal.

## Dialogs, keyboard and scrolling

Use native dialogs or equivalently accessible focus-managed surfaces. Bound them to the usable viewport with dynamic viewport units and visual-viewport adjustment where needed. Small screens may use near-full-screen dialogs. Allow content to scroll while primary actions remain reachable; do not trap large forms between oversized fixed headers/footers. Preserve a route back to dishes and a visible Close action. Orientation/keyboard changes must not lose entered values.

Ordinary pages may scroll vertically, but must not scroll horizontally. Min-width:0, wrapping and responsive grids should solve overflow rather than hiding it globally. Transform Menu pricing into labelled portion cards on narrow screens; scoped horizontal scrolling is only acceptable for genuinely unavoidable data regions. Native select option popups/file pickers are browser/OS surfaces. Use safe-area padding for fixed actions and leave matching content space; sticky elements must not cover focused inputs or the final row. Keep a single live cart/editor DOM rather than maintaining divergent mobile copies.

## Operational priorities

POS: categories/search, proportional optimized local images, multi-portion quantities and independent instructions, then an accessible cart/totals/confirmation/token flow. Kitchen: token, quantities, instructions, START/READY; retain FIFO and responsive density. Production: human-readable portion+dish title, total, useful instruction breakdown; no tokens. Dispatch: token, READY age, verification lines, Handed Over. Administration: clear labelled role targets, bounded forms and explicit save/reason controls.

## Required verification

Inspect 360×800, 390×844, 430×932, 768×1024, 1024×768, 1280×800, 1440×900 and 1600×900. Exercise actual workflows at representative mobile 390×844, tablet portrait 768×1024, landscape 1024×768 and desktop 1440×900, with boundary/long-text checks at the other sizes. Include login/logout, passwords, navigation, POS/menu/cart, menu/image/prices, staff roles/access/reset, Kitchen/Production/availability and Dispatch where implemented.

Use touch input in browser automation, check targets/overflow/dialog bounds, orientation changes, short usable heights, focus/keyboard behavior and screenshots. Block external traffic; fixtures must use isolated PostgreSQL schemas and temporary uploads, never restaurant data. Run npm run check, relevant browser regressions and required PostgreSQL regressions. Desktop Chromium touch emulation cannot certify physical Android/iOS keyboards, browser chrome or assistive technologies; record that limit explicitly and perform device smoke tests when hardware is available.

## Audit record

The 2026-09-23 audit includes the already implemented Dispatch milestone; the initial request referred to an earlier pre-Dispatch stage. No additional domain feature is introduced.

| Screen/surface                                 | Initial finding                                                                                                                  | Refinement                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login, overview, unavailable workspace, logout | Basic forms fit; shell could consume three navigation rows on phone                                                              | Compact permission-filtered workspace selector under 900px, bounded/wrapping header, readable native inputs                                                              |
| Change password, staff password reset          | Forms fit; short viewport and long summaries needed explicit coverage                                                            | Scrollable document flow, 44px disclosure targets, visible focus and constrained-height tests                                                                            |
| POS menu/search/categories/images              | Basic photo grid adapted already; cart followed entire menu on narrow screens                                                    | Persistent View Order with estimated total below 900px, one live focus-managed cart; two columns at landscape tablet widths                                              |
| Portion dialog/instructions/sold-out actions   | Native dialog and quantities already largely touch-sized; keyboard viewport was not tracked                                      | Dynamic/visual-viewport bounds, near-full-screen small dialog, whole-dialog scrolling at short heights; plain notes preserved                                            |
| Current Order/totals/token                     | Phone and portrait cart required scrolling past products; landscape stacked unnecessarily                                        | Modal cart with Back to dishes, independently scrolling rows and reachable totals/Confirm; orientation keeps cart state; phone line layout stacks variant above controls |
| Menu list/category editor/dish editor          | Narrow widths stacked full sidebar above editor; price matrix required horizontal region scrolling; category Edit was too narrow | Focused list/editor switching under 900px, persistent draft on Back, labelled variant/channel cards under 1200px, larger actions and bounded photo/file controls         |
| Staff list/create/access/multi-role/reset      | Checkbox labels and summaries were undersized                                                                                    | At least 44px label/disclosure targets, wrapping long names/roles and bounded forms                                                                                      |
| Kitchen Order/Production/late states           | Existing 3/4-column desktop, reduced tablet and single-phone grids already worked                                                | Preserve those grids; shared wrapping/focus/touch rules and long-content checks                                                                                          |
| Kitchen availability                           | Existing narrow layout already stacked actions; header/long names needed hardening                                               | Sticky close header, phone viewport bounds and long-name wrapping                                                                                                        |
| Dispatch                                       | Existing responsive grid, handover target and secondary notes already worked                                                     | Preserve domain/UI hierarchy; shared navigation/touch and long-content support                                                                                           |

No backend rules, APIs, migrations, authentication/RBAC, money, aggregation, availability or lifecycle semantics changed. No cloud dependencies or additional UI framework.

`npm run test:responsive-browser` uses local Chromium (CHROME_BINARY required), isolated PostgreSQL/media fixtures and blocked external requests. All eight sizes receive route/dialog/target/overflow checks; four representative classes exercise touch login, category/variant/pricing/image save, independent portion instructions/cart editing/confirmation/token, Kitchen/Production/availability/START/READY, Dispatch handover, staff creation/multi-role editing/deactivation/reset, and password forms. Long category/dish/variant names and 500-character-scale plain instructions exercise all sizes. Orientation and short-height form behavior are included. Successful password change/relogin is also exercised. Screenshots and the JSON audit report are written under `/tmp/dukanos-responsive-*`; screenshots must be visually reviewed, not treated as proof by themselves.

Remaining verification boundary: browser emulation verifies layout and touch event paths, not physical iOS Safari/Android keyboard, native file/select picker, browser-chrome or screen-reader behavior. Physical-device smoke checks remain necessary when hardware is available. The visual viewport listener and `interactive-widget=resizes-content` hint accommodate supported browser keyboard resizing; browser/OS support varies.

### Verification results

The completed audit passed all eight required viewport sizes and the four representative touch workflows. `npm run check`, all 77 PostgreSQL integration tests, and the existing Menu/POS, Kitchen and Dispatch browser regressions passed. External requests were blocked during browser verification. Screenshot review covered phone POS/cart/portion and password forms, stacked channel prices, portrait Kitchen Production, landscape POS, and desktop long-name/instruction wrapping. The initial failures listed above were fixed; no tested layout/workflow failure remains. Screenshots and the detailed JSON report are temporary local artifacts and can be regenerated with the documented command. Physical-device limitations above remain.

## Bill settlement presentation

Bills use responsive cards, natural document scrolling, labelled decimal amount/native method controls and no hover-only actions. POS Service/reference remains within the existing single cart surface; Open Bills and Add Items reuse the approved menu/cart flow. Dispatch exposes only concise service/payment status and a capability-gated Collect Payment link. Collection recovery survives tab reload at the bill URL; retry remains reachable at keyboard-constrained heights. `npm run test:bills-browser` exercises Dine In additional rounds/partial settlement/closure, Takeaway handover gating, role-union collection, lost response/reload and duplicate submission at the four representative classes plus long-reference layouts at all eight sizes. Physical device limitations above still apply.

## Confirmation and alert presentation

Payment review replaces content inside the existing single CartSurface, with a bounded scroll area, large full Cash/UPI and Pay Later choices, and optional two-field split form. Back returns to the preserved draft. Bill rounds wrap snapshot food/portion/instruction text naturally. Payment reminders use a compact expandable sticky tray in the POS menu pane or above Bill detail; due count remains visible, details scroll within a bounded height. Timers use a secondary Kitchen strip and natural-flow bounded-width form, preserving existing Order/Production grids. Inputs/buttons retain 44px minimum and no hover dependency.

`npm run test:alerts-browser` covers confirmation receipts, multi-round Dine In settlement/reminders and associated Kitchen timers with two devices, reload, offline known-state countdown and backend reconciliation. Fixtures advance absolute timestamps in isolated test schemas; production elapsed timers cannot be edited. Eight viewport sizes and four touch workflow classes follow this document's verification matrix; artifacts use /tmp/dukanos-alerts-*. Physical background/keyboard behavior still requires real-device verification.

Sound controls wrap compactly inside the POS menu pane/Bill workspace and Kitchen timer strip, retaining 44px minimum touch targets. Enable, mute and Test sound require no Admin navigation. `test:alerts-browser` exercises activation and both local tone patterns in the four touch workflow classes, plus offline expiry and resolution. No physical speaker/background-suspension guarantee is inferred from Chromium emulation.
