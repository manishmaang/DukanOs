# Dispatch compatibility boundary

The separate Dispatch screen is retired by the real-shop workflow milestone. Navigation and workspace selection omit it; authorized legacy /dispatch hash routes redirect to Kitchen. Kitchen now handles Dine-In serving and Parcel/platform handover. See [Kitchen](kitchen.md).

No Dispatch table/history/permission is dropped. Existing GET /api/dispatch/orders (dispatch.read) and POST /api/dispatch/orders/:id/complete (dispatch.complete) remain compatible for legacy READY work. They continue using Orders history, settlement guards and immutable snapshots. Normal application navigation does not use them. Historical PREPARING/READY/COMPLETED records remain readable.

Migration 022 gives DISPATCH kitchen.read and kitchen.fulfill, allowing legacy staff assignments to use Kitchen without role edits. It grants no menu, timer, payment or administration capability. KITCHEN obtains kitchen.fulfill explicitly; role unions remain unchanged.

Parcel (internal TAKEAWAY) requires zero amount_due and refund_due for handover. Dine-In serving completion does not pay or close its Bill. Serving history prevents a legacy completion command from bypassing unserved Dine-In lines. Backend compatibility commands are retained deliberately, not a second supported staff workflow.
