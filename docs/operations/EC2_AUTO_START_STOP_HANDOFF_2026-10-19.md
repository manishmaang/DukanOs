# DukanOS — Production Status & EC2 Scheduling Handoff

**Checkpoint date:** 19 October 2026 (IST)

**Intended audience:** Codex / future implementation agent / project owner

**Suggested repository destination:** `docs/operations/EC2_AUTO_START_STOP_HANDOFF_2026-10-19.md`

**Status:** Production POS is operational; cost-saving EC2 scheduling setup is **PARTIALLY PREPARED AND NOT ENABLED**.

**Purpose:** Preserve exactly what has been implemented, tested, configured, and left pending so work can resume later without risking production or using tokens to reconstruct context.

> **Source of truth:** This handoff is based on the owner's reports and terminal/AWS Console outputs in the conversation through 19 October 2026. It is a checkpoint, **not** a substitute for inspecting the current repository, AWS configuration, or fresh production state. If anything differs, verify before acting. No credentials or secret keys are contained here.

---

> **Repository reconciliation (19 October 2026):** Imported from the owner-supplied handoff as reported evidence, not a fresh AWS audit or an instruction to resume operations. Corrected the operational role name from CHEF to KITCHEN and clarified cloud-only WAN dependence against the implementation. Repository backup unit/timer match the quoted settings. Previous-day cancellation runs within Bill rollover at HTTP startup and every 60 seconds, gated by configured local time (default 05:00); it is not a separate 05:00 cron job. No production connection or change occurred during this documentation update. This file supersedes earlier pending-cleanup status; historical runbooks remain evidence only. Scheduler work remains paused until separately requested.

## 1. Immediate owner update — real-shop use

The owner **tested DukanOS in the real restaurant on 19 October 2026** and reported that **everything was working perfectly in actual shop use**. The owner identified **a few usability/operational tweaks** that should be made before considering the system fully effective in day-to-day use. **The specific tweaks have not yet been supplied**; do not invent requirements, begin unrelated features, or assume production needs a rebuild.

**Priority for the next Codex session:** Ask the owner for the specific real-shop tweaks; handle each as its own scoped task following `AGENTS.md`. The EC2 automatic stop/start work described below was intentionally paused and can resume later at **Step 15**, without enabling any schedules prematurely.

## 2. Existing DukanOS system (established background)

- **Purpose:** Single-location restaurant point-of-sale, kitchen production and dispatch, with LAN continuity when hosted locally. The current cloud-only EC2 deployment requires WAN connectivity; no disconnected browser writes or automatic local fallback are implemented.
- **Backend:** NestJS / Node.js; **frontend:** React; **database:** PostgreSQL 16 (production database `dukanos_prod`, schema `dukanos`).
- **Primary functions in place:** Multi-role auth/RBAC; staff; menu categories/dishes/variants/prices/availability/images; Counter POS and manually recorded Zomato/Swiggy orders; Kitchen FIFO and preparation status; Dispatch; bills with multiple rounds; Cash/UPI collection, partial payments, refunds under cash-only rule; reminders and kitchen/payment audio alerts; immutable queued-order amendments; historical bill and current-business-date protections; reports; encrypted S3 backups.
- **Roles:** OWNER and MANAGER exclusive; KITCHEN/CASHIER/DISPATCH may combine as authorized. Permissions are enforced by backend.
- **Restaurant operation:** **12:00 PM noon until 1:00 AM the following day, every day** (`Asia/Kolkata`). Staff agreed to finish activity before a proposed **1:30 AM** automatic server shutdown. No active-order shutdown safeguard for 1:30 AM is requested **for now**; this can be changed later.
- **Customer-facing self-order/pickup website:** **Not yet built**. Website-after-hours availability is explicitly **out of scope for this scheduling phase**. Revisit EC2 uptime requirements when that website is developed.

## 3. Production environment and known identifiers

| Setting                          | Confirmed value / observation                                  |
| -------------------------------- | -------------------------------------------------------------- |
| AWS Region                       | `ap-south-1` (Mumbai)                                          |
| AWS Account                      | `645822828303`                                                 |
| EC2 Instance ID                  | `i-04f0a6cd86717bc7f`                                          |
| Instance display name            | `DuknaOs` (as shown in Console)                                |
| Instance size                    | `t3.small` (prior project context)                             |
| EC2 Elastic/public IP            | `13.233.74.152` (check current state before depending on this) |
| Site URL                         | `https://rudragiri-velvase.duckdns.org/`                       |
| EC2 OS clock                     | `Etc/UTC`                                                      |
| Restaurant timezone              | `Asia/Kolkata` (IST, UTC+05:30)                                |
| DukanOS systemd service          | `dukanos.service`                                              |
| PostgreSQL service               | `postgresql.service`                                           |
| Backup timer/service             | `dukanos-backup.timer` / `dukanos-backup.service`              |
| Backup script                    | `/opt/dukanos/current/deploy/backup-maintenance.sh`            |
| S3 bucket                        | `dukanos-backups-mumbai-rudragiri-velvase`                     |
| Backup prefix                    | `production/`                                                  |
| EC2 instance IAM role            | `DukanOS-EC2-BackupRole`                                       |
| AWS Scheduler IAM policy         | `DukanOS-EC2-Scheduler-Policy`                                 |
| AWS Scheduler execution IAM role | `DukanOS-EC2-Scheduler-Role`                                   |

**Do not store passwords, AWS access keys, GPG secrets or any recovery passphrases in this handoff, repository, tickets, logs or ChatGPT.**

## 4. Production database cleanup: completed and verified

A one-time deletion of test transactional data from **17 October 2026** is already **complete**. **DO NOT RE-RUN** the cleanup script or attempt to repeat deletion; it was deliberately designed to reject re-execution. The owner requested deletion of the October 17 report only (the earlier suggestion to delete all eight reports was withdrawn to avoid unnecessary changes).

The final cleanup transaction reported:

```
CLEANUP_TARGET_REPORT_ID=8166c1ae-1d2e-41d0-99e4-9c26b22dad6d
CLEANUP_REVIEW_FINGERPRINT=b48b849615ef78633e5333a47f31db174f0dd790fbee66c8aebbd50f021cac56
CLEANUP_DELETED={"bills":5,"orders":7,"payments":4,"order_items":9,"daily_reports":1,"kitchen_timers":1,"order_amendments":3,"order_status_history":18,"platform_order_cancellations":2}
CLEANUP_PRESERVATION_AND_TRIGGER_CHECKS_PASSED
COMMIT
CLEANUP_COMMITTED
CLEANUP_COMMAND_EXIT_CODE=0
```

All four payments were **test entries** totaling **₹1,100** (recorded Cash ₹280 and UPI ₹820); no actual customer payment was represented by these entries. A preceding dry-run rollback passed and a before/after verification produced `DATABASE_BEFORE_AFTER_IDENTICAL`. After the commit, independent checks reported `CLEANUP_DATABASE_VERIFIED` and `DATABASE_VERIFIED_AND_SERVICES_RESTORED`.

**Preserved after cleanup:** 118 menu items, 156 item variants, 15 categories, 40 menu-image DB records (and physical image files were not targeted), 293 menu-audit entries, 468 variant channel settings, 5 users, 21 schema migrations, daily order/bill number counters, all protected schema objects / constraints / 10 DML protection triggers, and **seven daily reports dated October 10–16**. Test transaction tables listed above were verified at zero; `daily_reports` at 7. The owner subsequently opened the live POS and reported normal operation, and later confirmed successful real-shop use.

**Last reviewed code state for cleanup (historical reference only):** repo `main` commit `a025cd7`; reviewed SQL files `scripts/cleanup-test-orders-2026-10-17.sql` and `scripts/verify-test-order-cleanup-2026-10-17.sql`; related runbook `docs/operations/TEST_ORDER_CLEANUP_2026-10-17.md`. At the time, the cleanup received 61 isolated PostgreSQL safety tests. Code and deployment may have evolved since: inspect HEAD, do not assume this remains current.

### Backup qualification

An encrypted pre-cleanup backup on S3, key:
`production/dukanos-2026-10-17T23-45-56.371Z-79244a8e-ac9b-4cac-9459-17a4bb78b570.tar.gpg`, was streamed from S3 and matched its `.sha256` companion (`BACKUP_SHA256_VERIFIED`). The latest backup log inspected during scheduler setup showed `Result=success`, `ExecMainStatus=0`, with execution from `2026-10-17 23:45:47 UTC` to `23:46:00 UTC` (about 13 seconds). **This is a historical successful backup, not proof of future backup success.**

**Remaining recovery risk:** Access to the _off-instance_ GPG private/decryption recovery key, and a successful restore of that specific archive, **have not been independently confirmed**. Verify recovery capability separately; never share secrets with an agent.

## 5. Why AWS EC2 scheduling is being implemented

The restaurant runs for 13 hours (noon to 1:00 AM), whereas EC2 currently runs 24/7. The owner wants to cut compute costs by stopping EC2 during unused hours while retaining early-morning database tasks.

**Proposed daily schedule in IST:**

| Time         | Planned activity                                              | Status                                                                        |
| ------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **1:30 AM**  | EC2 **STOP** after staff finishing window                     | **Schedule created, DISABLED**                                                |
| **4:45 AM**  | EC2 **START** for overnight business-day maintenance          | **Schedule created, DISABLED**                                                |
| **~5:00 AM** | Existing DukanOS previous-business-day cleanup/rollover logic | Implemented application behavior; verify exact triggering mechanism in source |
| **5:15 AM**  | Coordinated encrypted database backup to S3                   | Existing **enabled** systemd timer                                            |
| **5:45 AM**  | EC2 **STOP only if that morning's backup has succeeded**      | **NOT CREATED; safeguard NOT implemented**                                    |
| **11:30 AM** | EC2 **START** before restaurant opening                       | **Schedule created, DISABLED**                                                |
| **12:00 PM** | Shop opens                                                    | Owner-provided time                                                           |

Potential schedule math: EC2 stopped **1:30–4:45 AM = 3h15m** plus **5:45–11:30 AM = 5h45m**, totaling **9 hours/day**, i.e. **37.5% fewer running compute hours**, _if all four transitions operate as planned_. Actual billing savings will be smaller as EBS storage, public IPv4/Elastic IP and other resources may still incur costs. AWS charges and pricing need live verification for a monetary estimate. The daytime customer website, when built, will affect uptime assumptions.

**Safety requirement:** Never create an unconditional direct EC2 StopInstances schedule for 5:45 AM. If the 5:15 AM backup is missing, failed, incomplete, stale, or unverified, **leave EC2 running** and provide an alert/log. The S3 object and checksum existence alone are insufficient if their date or completion doesn't match this morning's run.

## 6. AWS actions already performed (through Step 14)

These actions were performed manually in the AWS Console by the owner. No scheduler has been enabled so far.

### Step 1 — Inspected DukanOS timers (done)

EC2 terminal confirmed OS UTC, `dukanos-backup.timer` with:

```ini
[Timer]
OnCalendar=*-*-* 23:45:00 UTC
Persistent=false
```

`23:45 UTC` corresponds to **05:15 IST the next calendar day**. The timer was enabled and active. **`Persistent=false` means a missed firing is not automatically replayed after an EC2 restart.** At the first inspection the next backup was 2026-10-18 23:45 UTC / October 19 05:15 IST.

### Step 2 — Checked boot and backup service (done)

```
systemctl is-enabled dukanos.service         # enabled
systemctl is-enabled postgresql.service      # enabled
systemctl is-enabled dukanos-backup.timer    # enabled
```

`dukanos-backup.service` is a `Type=oneshot` unit:

```ini
[Unit]
Description=Coordinated encrypted DukanOS full backup
After=network-online.target
[Service]
Type=oneshot
User=root
WorkingDirectory=/opt/dukanos/current
ExecStart=/bin/sh /opt/dukanos/current/deploy/backup-maintenance.sh
ExecStopPost=/usr/bin/systemctl start dukanos.service
TimeoutStartSec=30min
UMask=0077
```

**Important:** `ExecStopPost` starts the app after _any_ backup termination, including potential failure. Merely finding the app running is **not evidence that the backup succeeded**. Check the backup service outcome and the correct current-date S3 artifact/checksum.

### Step 3 — EC2 attribute check was denied (known, not blocking)

A read-only AWS CLI call from EC2 for `DescribeInstanceAttribute` returned `UnauthorizedOperation` because `DukanOS-EC2-BackupRole` didn't have `ec2:DescribeInstanceAttribute`. **Do not grant broad EC2 permissions to the backup role just to resolve this**. The planned EventBridge Scheduler uses AWS EC2 `StartInstances` / `StopInstances`, not in-guest OS `shutdown` behavior.

### Step 4 — Stop protection inspected (done)

AWS Console → EC2 → Instance settings → Change stop protection showed **Enable unchecked**, i.e. **stop protection disabled**. It was left unchanged. Owner has confirmed automatic EC2 stop is acceptable for this workload.

### Step 5 — Dedicated scheduler IAM policy created (done)

Policy name: `DukanOS-EC2-Scheduler-Policy`, containing **only** these actions scoped to **only** this EC2 instance:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ControlOnlyDukanOSEC2",
      "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances"],
      "Resource": "arn:aws:ec2:ap-south-1:645822828303:instance/i-04f0a6cd86717bc7f"
    }
  ]
}
```

### Step 6 — EventBridge Scheduler execution role created (done)

Role: `DukanOS-EC2-Scheduler-Role` with attached policy above. Intended trusted service principal: `scheduler.amazonaws.com`, restricted to AWS account and `ap-south-1` `default` schedule group. The console accepted role creation; actual trust and attachment should be checked before enabling schedules. **Keep this separate from** the EC2's `DukanOS-EC2-BackupRole`.

### Steps 7–9 — Three EventBridge schedules created, all **DISABLED**

Scheduler console region: `ap-south-1`. Schedule group: `default`. Timezone: `Asia/Kolkata`, recurring daily cron, flexible time window OFF, target **All APIs → EC2** and role `DukanOS-EC2-Scheduler-Role`. Instance input for each:

```json
{ "InstanceIds": ["i-04f0a6cd86717bc7f"] }
```

| Created schedule name           | Cron (Asia/Kolkata)   | Target               | State        |
| ------------------------------- | --------------------- | -------------------- | ------------ |
| `DukanOS-Start-Before-Opening`  | `cron(30 11 * * ? *)` | EC2 `StartInstances` | **DISABLED** |
| `DukanOS-Start-For-Maintenance` | `cron(45 4 * * ? *)`  | EC2 `StartInstances` | **DISABLED** |
| `DukanOS-Stop-After-Closing`    | `cron(30 1 * * ? *)`  | EC2 `StopInstances`  | **DISABLED** |

**No 5:45 AM schedule exists yet.** The 1:30 AM stop would be unconditional when enabled; owner chose this for now and can change it later. Since previous-business-date bill modifications are restricted, staff must record all real operations **before** the 1:30 AM stop.

### Steps 10–11 — Owner selected simple closing policy; SSM agent found (done)

At step 10, owner answered **No** to expecting staff still using POS after 1:30 AM; explicitly permitted later changes if actual operations require them. EC2 output:

```
snap.amazon-ssm-agent.amazon-ssm-agent.service loaded active running
```

### Step 12 — Managed node initially missing (observed)

Fleet Manager → Managed nodes initially did not list the EC2 instance, despite local agent running.

### Step 13 — Standard SSM IAM policy attached (done)

Owner added AWS-managed **`AmazonSSMManagedInstanceCore`** to the **existing EC2 instance role** `DukanOS-EC2-BackupRole`, **not** to the scheduler role. This is the only deliberate modification to the instance backup role during the scheduler work. Existing S3 backup permissions were not intentionally removed.

### Step 14 — Fleet Manager now lists instance (done)

On 19 October, the owner reported **the EC2 instance is now showing in Fleet Manager → Managed nodes**. This suggests SSM registration works after IAM permission update.

**Crucial distinction: the user's latest message confirmed LISTING, not the `Ping status` field.** We asked for Ping status `Online` at **Step 15**, but **no answer has yet been provided**. Do not mark SSM online or Run Command working without checking.

## 7. Exactly where to resume the scheduler project

**NEXT STEP (Step 15):** Open AWS Console → Systems Manager → Fleet Manager → Managed nodes → `i-04f0a6cd86717bc7f`, and verify **Ping status: `Online`**. If not Online, troubleshoot IAM/SSM network permissions and endpoints without stopping production.

**After Step 15, not yet performed:**

1. Execute a **harmless, read-only SSM Run Command** on the instance, e.g. `date -u` and read-only `systemctl show dukanos-backup.service` (no service restart, no EC2 shutdown). Verify SSM Run Command success and avoid exposing credentials.
2. Design the **5:45 AM guarded EC2 stop** using a minimal external control mechanism (e.g. EventBridge Scheduler invoking a Lambda that reads backup status using carefully restricted SSM Run Command, validates success, then calls `StopInstances`). Alternative designs are possible; **choose after checking actual backup script behavior and least-privilege needs**. Do not assume the existing Scheduler role is sufficient for Lambda/SSM; create purpose-specific limited permissions if required.
3. Confirm 5:15 AM backup **for the correct business day** has finished with `Result=success`, `ExecMainStatus=0`, recent invocation timestamp, complete S3 `.tar.gpg` + `.sha256` and checksum verification (streaming hash or other proven mechanism), not merely older historical success. Consider current-date report/cursor/rollover logic.
4. Failure mode must be **fail-open (keep instance RUNNING)** if SSM is offline, backup not completed, checksum missing/mismatch, or IAM/AWS error. Add useful logs and alerts. Avoid giving the Lambda broad delete, instance-terminate or database privileges.
5. Verify auto-start reaches functioning PostgreSQL, DukanOS API, HTTPS, required internet access and backup timer. Test boot readiness against maintenance times; allow for boot and service startup delays.
6. Confirm the actual **05:00 AM previous-day cleanup task** implementation and execution guarantee. Unlike the systemd backup timer, this was described as app behavior: inspect source before depending on it. Verify correctness after 4:45 AM EC2 start.
7. Review interactions between backup lock, in-progress I/O, shutdown race, systemd service, EventBridge retry behavior, SSM connectivity and idempotency. A fixed 5:45 stop must not interrupt a slow backup. If checks are inconclusive, **do not stop**.
8. Verify Scheduler execution IAM trust and three disabled schedules in Console. Then perform controlled nonproduction tests or narrowly scoped read-only smoke tests before enabling anything. Plan rollback/disable procedure in advance; warn owner of downtime.
9. When all protections have been tested and owner explicitly authorizes activation, enable schedules **in a coordinated manner**. Do not enable only stop schedules, and never perform an unscheduled live stop during restaurant hours.
10. Monitor first actual stop/start/backup cycle, EC2 status, DukanOS health, HTTPS and S3 artifact. Keep a clear fall-back: AWS Console manual EC2 StartInstances, disable schedules on failure.

**Activation status right now:** **0 of the 3 created schedules enabled.** The 5:45 guarded stop is **not implemented**. No live automatic EC2 stop/start has been tested.

## 8. Safety and reliability decisions

- **Never treat `systemctl` enabled as proof of a successful future boot**: test it after EC2 stop/start.
- **AWS stop is not terminate.** Never permit `TerminateInstances` or `DeleteVolume`.
- Retain the EBS storage and database; the system must restart against the **same instance and volumes**, without resetting data or renumbering existing business records.
- Existing app + DB run on the same EC2; there may be several minutes of downtime during cold start. Starting at 11:30 AM allows 30 minutes before opening; 4:45 AM allows 15 minutes before 5:00 AM maintenance, but verify actual startup speed.
- Daily backup timer uses **server UTC** even when EventBridge schedules use **Asia/Kolkata**.
- `Persistent=false`: a missed 5:15 AM backup is not replayed later. Guarded stop must recognize a missing backup and preserve uptime.
- The current customer-facing ordering website has not been built; scheduling may need redesign when advance ordering becomes available.
- **Production-tested menu/data must not be changed by AWS cost-optimization work.** Scheduler work is infrastructure-only unless explicitly authorized otherwise.
- **A fixed 1:30 AM shutdown has no in-flight order guard today.** Owner accepted this temporary limitation and may revise later.
- Never use SSM Fleet listing alone as proof of online command execution.
- Backup recovery key retrieval/restore capability still needs an independent check.
- Avoid modifying the EC2's backup role except for the already-installed `AmazonSSMManagedInstanceCore` unless strictly justified.
- Customer data, future genuine payments and sales must not be inadvertently purged by historical test cleanup scripts.

## 9. Codex working rules and requested handoff behavior

When Codex is asked to work on **either real-shop UX tweaks or the scheduler**:

1. **Before editing anything, read `AGENTS.md` and all required master/context/architecture/operations/module documents.** This is mandatory and takes precedence over the handoff summary.
2. Examine current Git branch, repository status, migrations, deployment instructions, and existing docs. Do not assume all descriptions above match latest HEAD.
3. **Create a new Git branch for each independent feature/fix**, respecting project naming and branching rules. Do not mix restaurant UX fixes with AWS scheduler work.
4. Produce a short plan, exact scope, risks, acceptance criteria and tests before implementing. Do not silently introduce unrelated behavior.
5. **Documentation updates are a top-priority completion criterion**, not an afterthought: update relevant module docs, operations runbook, architecture/decision notes, change log and master project checkpoint/README according to `AGENTS.md`.
6. Maintain a checkpoint describing **active branch, task, implementation status, pending steps, and recommended point of resumption**; preserve old evidence rather than overwriting it without reason.
7. Validate lint, types, tests and relevant PostgreSQL/AWS behavior. Include execution evidence and migration impact in the final report.
8. Unless the owner separately gives explicit operational authorization, **do not access or change production AWS scheduling, roles, databases, deployed code, files, server startup behavior, backup timers or EC2 power state**. Repo-only design and code/test changes can be prepared for review.
9. Never hardcode AWS secrets, private keys or passwords. Use documented, minimal IAM roles.
10. Report exactly what was changed, what was _not_ changed, how it was tested, and how to safely roll back.

## 10. Open questions and pending owner input

- **Real-shop tweaks:** Owner said several tweaks are needed; exact issues and expected behavior have **not yet been described**. Ask for them before writing Codex implementation prompts.
- **SSM online:** Is managed-node Ping status `Online`? Not yet confirmed.
- **SSM Run Command:** Not tested.
- **5:45 guard:** Not implemented, and no Lambda/Step Functions or additional IAM permissions created for it.
- **Schedule enablement:** All three existing schedules disabled by design, not an error.
- **Post-boot checks:** No automated service/website readiness tests implemented or reported.
- **Backup recovery:** Latest archive integrity verified; external private-key availability / successful restore not yet confirmed.
- **Actual monthly AWS savings:** Not measured or verified; only compute-hour estimates exist.
- **Real shop future hours and special days:** currently owner stated daily noon–1 AM; can adjust schedule later.

## 11. Minimal ready-to-paste Codex continuation instruction

> Read `AGENTS.md` and all repository-required context first. Use this handoff as a historical checkpoint, verify the current branch and AWS state, and **do not touch production** without explicit owner authorization. DukanOS was successfully used in the live restaurant on 19 October 2026; the owner has several as-yet-unspecified tweaks to prioritize. The AWS cost-saving automation is paused at Step 15: EC2 SSM agent runs, `AmazonSSMManagedInstanceCore` was added to `DukanOS-EC2-BackupRole`, the instance now appears in Fleet Manager, but Ping `Online` and Run Command are not yet confirmed. Three EventBridge Scheduler schedules (1:30 AM stop, 4:45 AM start, 11:30 AM start) have been created **DISABLED**. The mandatory guarded 5:45 AM stop after the 5:15 AM S3 backup does not exist yet. Do not enable schedules or implement a blind shutdown. Resume only when the owner asks. For every independent code task: new branch, tests, documentation updates as first-class completion criteria, and a final checkpoint with rollback instructions.

---

**Owner's chosen priority as of this handoff:** Address the feedback from actual restaurant use first; return later to the EC2 scheduling task at Step 15. Nothing in this document authorizes Codex to change production.
