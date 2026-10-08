# AWS pilot preparation checkpoint

Authorized scope: Phase A automatic previous-date order cleanup, then Phase B essential AWS deployment hardening. No AWS resources, deployment or additional business milestones.

Starting main: a190635 (completed readiness audit). Phase A branch: feature/previous-day-order-cleanup; migration 019. Phase A implementation and verification complete; Phase B has not started. Phase A delivery is the commit titled `Implement previous-business-day order cleanup` on that branch. Commit hashes will be recorded in the next phase checkpoint.

Owner delegated timing choice: use today's configured gate for all earlier-date unfinished orders, including orders older than yesterday. Default 05:00 Asia/Kolkata. Preserve calendar midnight and immutable report versions.

Verified: `npm run check`; full PostgreSQL suite (196 passed before three further test cases); final focused cleanup suite (31 passed); final lint/format checks; Kitchen, Dispatch, Bills, amendments and Daily Reports browser scripts all passed. New cases include populated migration preservation, transactional rollback and non-default timezone/cutoff periodic execution. No live data migration was run.

Next required work: commit/push and merge the announced completed Phase A milestone under AGENTS, then create Phase B fresh from updated main. Phase B must cover H1–H5, operational safeguards, safe backup/restore rehearsal and SMTP transient error correction. Preserve audit history and classify actual AWS setup conditions separately from implemented/tested safeguards.
