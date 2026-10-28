# OmnishPilot — capability map

Research snapshot (2026-10-28) of what makes a **killer** local autonomy harness, what we have, and what to add next.

## Killer bar (from field + competitors)

| Need | Why it matters | Who already does a slice |
|------|----------------|--------------------------|
| Skip per-tool approvals | Approval walls kill automation | Claude `--dangerously-skip-permissions`, Cursor `--yolo`, Codex YOLO |
| Real isolation | Skip-permissions without a box = host YOLO | Claude sandbox runtime, bwrap patterns, Docker/microVM |
| Any agent on the machine | Avoid vendor lock | Open Run, Agent Cron, agent-run |
| Job lifecycle | Fire-and-forget needs queue, logs, retry, notify | OmnishPilot, Open Run, loop-harness |
| Done ≠ “model stopped” | Acceptance / verifier gates | loop-harness (verifier agent), CI |
| Failover | Rate limits / outages | OmnishPilot preferredOrder + cooldown |
| Soak / deny-test | Prove autonomy + escape blocked | OmnishPilot `sandbox deny-test` |

## Have now

- Multi-agent via `agent-run` (cursor-agent, claude, agy, …)
- Unattended command templates (`--yolo` / `--dangerously-skip-permissions`)
- **Sandbox wrap** on generic-agent jobs (`server/sandbox.js`, bwrap default)
- `omnishpilot doctor` sandbox + autonomous gate
- `omnishpilot sandbox status|check|deny-test`
- `omnishpilot capabilities`
- Scheduler, worker, supervisor heartbeats, Omnish notify/delivery
- Quick-add plain language → job spec
- Workload templates (social video, research, code change) as proof jobs

## Add next (priority)

1. **Acceptance profiles** — required artifacts / test command; supervisor retries until green; human reviews the pack, not every Bash.
2. **Git worktree per run** — never touch the dirty checkout (Open Run / loop-harness pattern).
3. **Verifier agent** — second pass must print PASS before delivery/ship.
4. **Prompt-hang detector** — if agent waits on TTY/approval, mark failed (don’t sit in `running`).
5. **Webhook triggers** — GitHub/Linear wake a sandboxed job.
6. **macOS Seatbelt / Windows isolation** — parity beyond Linux bwrap.
7. **Resource limits** — cgroups/timeouts so a runaway agent can’t melt the box.

## Config surface

```json
"sandbox": {
  "enabled": true,
  "backend": "auto",
  "network": true,
  "requireForAutonomous": true,
  "hidePaths": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.docker"],
  "extraBindRw": []
}
```

## Non-goals (for now)

- Being simpler than Claude routines
- Paid SaaS / multi-tenant billing
- Replacing Open Run’s git-diff PR UI
