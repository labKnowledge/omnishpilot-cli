# What people struggle with when they schedule tasks and agents

Research brief, 2026-10-28. Sources: a Gemini Notebook deep-research run (44 sources, notebook "Agent & task scheduling pain points", id `3609a6f5-459e-420b-ae0a-557b53376a0b`) plus separate web searches. I spot-checked the headline numbers against the raw source text; the ones I couldn't trace to a primary source are marked.

## The short answer

The biggest problem is that people can't tell whether a scheduled job actually did its work. A job that never fired, hung, stalled on a prompt or "finished" without doing anything looks the same as a job that succeeded, and people find out days or weeks later, usually from a customer or a missing backup.

This was true for plain cron long before agents. Agents make it worse because they fail in more ways (prompts, rate limits, hangs, half-finished work) and because their own summary of what they did is unreliable. Almost every other complaint in the sources turns into this one once nobody is watching: a permission prompt nobody answers, a rate limit that kills the overnight run, a timeout that leaves a green status.

## Ranked problems

### 1. Silent failure and false "success"

Raised by more sources than anything else, and across every tool: cron, n8n, GitHub Actions, Claude Code routines.

- Cron records exit codes, not outcomes. An agent that times out on the LLM API, catches the exception and exits 0 is logged as a success (Tian Pan).
- Anthropic's own wording, quoted in the Orchestra guide: "A green status in the run list means the session started and exited without an infrastructure error. It does not mean the task in your prompt succeeded." The guide's point is that a nightly routine can show green for a month while doing nothing.
- n8n users report nodes that hang without raising an error, and execution timeouts that skip the error workflow entirely.
- Founders on Indie Hackers describe automations that stopped for days after a credential expired, and backups that failed for weeks unnoticed.
- The agent's self-report can't be trusted as the check: a large developer-agent study cited by Ranjan Kumar puts inaccurate self-reporting at 22.58% of misalignment cases.

An arXiv survey paper quotes an estimate that "78% of AI failures are invisible". It's a secondhand figure; I couldn't find the original.

### 2. Permissions: either the job stalls, or it runs with no guardrails

Unattended runs remove the human who used to answer prompts. People hit one of two walls.

- The job stops. In Claude Code print mode an unlisted tool call aborts the run. Claude Code issue #81948 reports a scheduled routine re-prompting on every fire for a Write that was already in `permissions.allow` and already "always allowed"; six stalled sessions in one day. It was auto-closed as stale in October 2026 with no maintainer reply.
- Or people reach for `--dangerously-skip-permissions` to make it "just work", which removes every gate at once. The same study found developer-constraint violations rise from 32.26% of misalignment cases in IDE sessions to 49.49% in CLI and delegated workflows.
- Interactive prompting is weak anyway: an arXiv analysis of Claude Code cites Anthropic's finding that users approve about 93% of permission prompts.

### 3. Timeouts and hangs

Agent work takes minutes to hours; the plumbing around it expects seconds. Sources list VS Code/MCP client limits of 10 to 15 seconds, n8n's 60-second HTTP node and 2-minute default workflow timeout, and Railway's 15-minute edge limit. The symptom is a severed or hanging run, often reported as a generic 500 or nothing at all.

### 4. Rate limits and usage windows

Scheduled jobs share the same quota as daytime work. Claude Code subscribers have a rolling 5-hour window, so heavy manual use in the evening can starve the overnight job (Usagebar). Claude routines add their own caps. Jobs that all fire on the hour cause "thundering herd" 429s. In the other direction, runaway loops with no stop signal produce surprise bills; one source cites a $400 overnight run.

### 5. No checkpoint, so a crash means starting over

When a multi-step agent dies midway, a stateless scheduler restarts it from step one, paying for the tokens again and repeating side effects. Overlapping runs (the next tick firing while the last one is still going) corrupt shared state. Lindy moved from BullMQ to Temporal to get durable, resumable runs.

### 6. The trigger itself is unreliable

GitHub Actions cron fires 3 to 10 minutes late under load, sometimes over an hour. Local schedulers miss runs when the laptop sleeps. Claude routines skip runs for up to 72 hours when the GitHub connection expires (Claude Code docs).

### 7. Prompt injection through scheduled inputs

A job that reads issues, email or web pages on a clock gives an attacker a predictable window to plant instructions, and nobody reads the prompt before the agent acts on it (Mint Security). October 2026 reports of malicious AGENTS.md files in Downloads folders tricking coding agents fit the same pattern.

## Why the scheduler is the wrong place to look

Cron's model is: short, deterministic, stateless, exit code tells the truth. Agent jobs break all four. The sources that dig deepest (Tian Pan, Ranjan Kumar, Mint Security) land in the same place: the hard part of scheduling agents isn't picking the time; it's everything a watching human used to do. Approve or refuse actions, notice a hang, check the output was real, retry sensibly, and tell someone.

## What this means for OmnishPilot

Checked against `docs/capabilities.md` and `runtime/server`. Most of the list above is already covered:

- Silent failure: acceptance profiles (required artifacts, test command), optional verifier agent, morning pack via Omnish. This is the strongest answer to problem 1, because it judges outcome, not exit code.
- Permissions: YOLO inside a bwrap/docker/firejail sandbox, plus `sandbox deny-test`. Neither wall from problem 2.
- Hangs: prompt-hang detector plus hard job timeout.
- Rate limits: failover to another agent CLI and resume-at-reset.
- Overlap: `maxConcurrent: 1` in `store.js` and the status check in `worker.js` stop a second copy starting.
- Missed runs: `scheduler.isDue` treats any `runAt <= now` as due, so a run missed while the machine slept fires on wake.

Gaps worth looking at:

- Checkpoint and resume inside a single run. A crashed job restarts from scratch; nothing persists progress between steps.
- A "this job didn't run" alert. Notifications go out when something finishes; if the daemon itself is down, nothing says so. An external heartbeat (the dead-man's-switch pattern that cron monitors use) would close that.
- Spend caps per job. Rate-limit failover handles quotas, but nothing stops a looping agent from burning through a pay-as-you-go key.
- Injection exposure for webhook-triggered jobs. GitHub and Linear payloads are summarized into the agent prompt; the sandbox limits the damage, but the input is untrusted.

The pitch that matches problem 1: people don't need another way to set a time. They need to wake up and know, without reading logs, whether the work got done.

## Sources

- Tian Pan, [Event-driven agent scheduling: why cron + REST calls fail](https://tianpan.co/blog/2026-04-17-event-driven-agent-scheduling-cron-failure-message-queue)
- Ranjan Kumar, [Headless Claude Code, hooks and the human backstop](https://ranjankumar.in/claude-code-headless-hooks-human-backstop)
- Mint Security, [Scheduled agents are unattended agents](https://www.mint.security/blog/scheduled-agents-are-unattended-agents-a-posture-model-for-routines)
- Orchestra, [Claude Routines: the complete guide](https://www.getorchestra.io/knowledge-hub/glossary/claude-routines)
- Claude Code docs, [Automate work with scheduled tasks](https://code.claude.com/docs/en/routines)
- GitHub, [anthropics/claude-code#81948](https://github.com/anthropics/claude-code/issues/81948)
- arXiv, [Dive into Claude Code](https://arxiv.org/html/2604.14228v3)
- Usagebar, [How to set up cron jobs with Claude Code](https://usagebar.com/blog/how-to-do-cron-job-setup-on-claude-code)
- n8n community, [How to handle timeout workflow error](https://community.n8n.io/t/how-to-handle-timeout-workflow-error/235704)
- n8n, [issue #18368](https://github.com/n8n-io/n8n/issues/18368)
- Stack Overflow, [GitHub Actions cron triggers late](https://stackoverflow.com/questions/67077120/github-actions-cronjob-trigger-seems-to-trigger-an-hour-later)
- Reddit r/node, [State persistence for long-running jobs](https://www.reddit.com/r/node/comments/1qkb3oa/how_are_you_handling_state_persistence_for/)
- Indie Hackers, [How are you monitoring cron jobs and background automations?](https://www.indiehackers.com/post/how-are-you-monitoring-cron-jobs-scheduled-tasks-and-background-automations-today-1b42091385)
- Brian Fischman, [I tried to run an AI coding agent overnight](https://brianfischman.medium.com/i-tried-to-run-an-ai-coding-agent-overnight-heres-what-actually-happened-f97288b7be35)
- Developers Digest, [Deploy an agent behind a webhook on Railway](https://www.developersdigest.tech/blog/deploy-agent-webhook-railway)
- The Hacker News, [Malicious file in Downloads folder tricks AI coding agents](https://thehackernews.com/2026/10/malicious-file-in-downloads-folder.html)
