# OmnishPilot — improvement opportunities

Research synthesis (scheduling pain points + competitive landscape of local
agent harnesses, 2026). Prioritize by user leverage: absorb complexity, prove
outcomes, widen who can install.

## Already strong (keep sharpening)

- YOLO inside sandbox + `deny-test`
- Acceptance / verifier gates (outcome ≠ exit code)
- Hang detector, rate-limit failover, worktrees, webhooks, budget caps
- Deterministic CLI ADD contract + auto-start daemon
- Shell-command jobs for non-AI cron

## High-impact gaps

| Area | Why | Direction |
|------|-----|-----------|
| **Daemon dead-man’s switch** | If the control plane is down, jobs silently never run | External heartbeat / Omnish “Pilot offline” ping |
| **In-run checkpoint/resume** | Crash restarts multi-step agent from zero | Persist step ledger; resume prompt with prior artifacts |
| **First-run wizard** | Normies bounce on sandbox/agent PATH | `omnishpilot init` interactive: doctor fixes, first job, UI password |
| **Plain-language schedule (UI only)** | CLI stays deterministic; UI can NLP | Keep CLI flags; improve quick-add interpreter + confirm card |
| **macOS / Windows sandbox parity** | Linux bwrap is best; others feel second-class | Document docker path; one-click backend install hints in doctor |
| **Skill + MCP dual surface** | Agents discover tools differently | Ship skill (done) + optional MCP server wrapping same contract |
| **One-command demo** | Adoption needs a 30s win | `omnishpilot demo` creates a safe shell job + follow |
| **Webhook injection hygiene** | Untrusted issue text → prompt | Sanitize / fence external payloads; allowlist fields |
| **Per-job spend caps** | Global budget helps; runaway single job still hurts | Cap tokens/minutes per job id |
| **Mobile-first status** | Non-devs want “did it finish?” | Deeper Omnish morning pack + SMS/email fallbacks |

## Agent ergonomics (this release)

- `omnishpilot guide [--json]` — usable with zero skills  
- Global skill install to `~/.agents/skills` on `npm i -g`  
- Doctor reports skill presence  
- `AGENTS.md` in the package for repo-aware agents  

## Distribution for global reach

1. npm global + clear README badges (have)  
2. Skill on skills.sh / `npx skills add` after skill-publish  
3. Homebrew / Scoop formulas (discoverability outside npm)  
4. Short demo video + Reddit/HN feedback loops (`docs/outreach-reddit.md`)  
5. “For everyone” copy: schedule a reminder that *thinks*, not only coding demos  

## Product philosophy check

Every feature should answer: **can the user accomplish more by doing less?**
Prefer inferred workspace, auto doctor repairs, one `add --follow`, and a
morning verdict over more config knobs.
