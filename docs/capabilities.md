# OmnishPilot — capability map

Research + implementation snapshot of the local autonomy harness.

## Killer bar

| Need | Why it matters | Status |
|------|----------------|--------|
| Skip per-tool approvals | Approval walls kill automation | **have** (YOLO inside sandbox) |
| Real isolation | Skip-permissions without a box = host YOLO | **have** (bwrap / docker / firejail) |
| Any agent on the machine | Avoid vendor lock | **have** (bundled agent-run) |
| Job lifecycle | Fire-and-forget needs queue, logs, retry, notify | **have** |
| Done ≠ “model stopped” | Acceptance / verifier gates | **have** |
| Failover + resume-at-reset | Rate limits / outages | **have** |
| Hang / timeout kill | Silent TTY waits | **have** |
| Worktree isolation | Dirty checkout / parallel collisions | **have** |
| Webhook wake | GitHub / Linear start a job | **have** |
| Morning pack | Wake to a verdict, not a log wall | **have** |
| Soak / deny-test | Prove autonomy + escape blocked | **have** |
| Pure terminal schedule | Cron-like commands/scripts/apps, no agent | **have** |

## Have now

- **Bundled `agent-run`** — ships in-package (Node); no separate install / no Python
- Multi-agent via bundled agent-run (PATH-resolved agent CLIs; no hardcoded home path)
- Unattended command templates (`--yolo` / `--dangerously-skip-permissions`)
- Sandbox wrap + `doctor` / `deny-test` / autonomous gate (OS backends: bwrap / docker / firejail — optional)
- Scheduler, worker, supervisor heartbeats, Omnish notify/delivery (Omnish optional)
- **Shell-command jobs** — schedule any terminal command, script, or app with no agent (`templateId: shell-command`, CLI `--command`)
- **Acceptance profiles** — required artifacts + optional test command; retry until green
- **Verifier agent** — optional second pass must print `VERDICT: PASS`
- **Git worktree per run** — generic-agent jobs on git workspaces
- **Prompt-hang detector** — approval/TTY idle + hard job timeout
- **Rate-limit failover** — cooldown with parsed reset; resume-at-reset when all limited
- **Webhook triggers** — `POST /hooks/github|linear|generic?token=…`
- **Morning pack** — gate + artifacts + diff summary via Omnish
- Quick-add plain language → job spec
- Workload templates (social video, research, code change, terminal command)
- **Failure triage** — a crash or flaky run is retried; a signed-out agent, missing command, approval prompt or hard timeout fails at once with the fix, told once per agent or job
- **Retry context** — a retried agent is told the first run may have done part of the work, so it checks before redoing anything
- **Recurring jobs survive a failure** — a nightly job that fails keeps its schedule; the same failure two nights running notifies once
- **Crash-safe state** — tasks, settings and config are written atomically with fsync; a damaged `tasks.json` is set aside and restored from its last good copy
- **Failure backoff** — a recurring job that keeps failing waits 15 minutes, then 30, doubling up to 4 hours, so a broken 5-minute job doesn't fail every 5 minutes
- **Weekly health** — each recurring job shows "6 of 7 runs succeeded in the last 7 days" in `omnishpilot tasks`, `task <id>` and the web UI
- **Keep awake** — the machine can't sleep while a job runs or is due within 15 minutes (`systemd-inhibit` on Linux, `caffeinate` on macOS, `SetThreadExecutionState` on Windows); the lock dies with the daemon
- **Budget caps** — `omnishpilot budget --minutes 180 --usd 20`: agent minutes per day and reported spend per month, warning at 80%; agent jobs over a cap wait, terminal jobs still run
- **Webhook redelivery** — an event redelivered with the same `X-GitHub-Delivery` / `Linear-Delivery` / `Idempotency-Key` within 7 days returns the job it already started

## Config surface (new)

```json
"acceptance": { "enabled": true, "defaultArtifacts": ["result.md"], "verifier": false },
"worktree": { "enabled": true, "keepOnFailure": true },
"webhooks": { "enabled": true, "token": "set-me" },
"worker": {
  "hangIdleMinutes": 12,
  "hangHardMinutes": 45,
  "jobTimeoutMinutes": 240,
  "keepAwake": true,
  "keepAwakeMinutes": 15
},
"budget": { "dailyAgentMinutes": 180, "monthlyUsd": 20, "warnAtPercent": 80 }
```

## Webhooks

Set `webhooks.token` (or `OMNISHPILOT_WEBHOOK_TOKEN`), then:

```bash
curl -X POST "http://127.0.0.1:4580/hooks/generic?token=YOUR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Triage bug","goal":"Investigate and write result.md","workspace":"/path/to/repo"}'
```

GitHub / Linear payloads are summarized automatically into an `agent-task`.

## Dependency posture

| Dependency | Status |
|------------|--------|
| Node 18+ | required |
| express | npm dependency (shipped) |
| **agent-run** | **bundled** in this package (`bin/agent-run.js`) |
| Agent CLIs (cursor-agent, claude, …) | optional — needed only for agent jobs |
| Omnish | optional — notify / morning pack |
| bubblewrap / docker / firejail | optional — Linux sandbox for autonomous agent runs |
| git | optional — worktree isolation |
| python3 | optional — Leaptr campaign state tools only |

No separate agent-run install. Shell-command jobs need none of the agent/Omnish stack.

## Non-goals (for now)

- Being simpler than Claude routines
- Paid SaaS / multi-tenant billing
- Replacing Open Run’s full git-diff PR UI (we deliver a pack + worktree path instead)
