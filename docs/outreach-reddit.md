# Where to post OmnishPilot for feedback

Goal: get honest feedback from builders, developers, and power users — not spam.
Post as a builder seeking critique; lead with the problem you solve (silent
failures + approval walls on scheduled agents), then the install line.

## Best-fit subreddits (2025–2026 signal)

| Subreddit | Why it fits | Angle |
|-----------|-------------|-------|
| [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/) | Active threads on scheduled Claude, overnight PRs, routines | Multi-agent + sandbox vs single-vendor routines |
| [r/cursor](https://www.reddit.com/r/cursor/) | Cursor CLI / Automations users hitting approval walls | `cursor-agent` unattended inside bwrap |
| [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/) | Broader Claude audience; routines discussions | “Cron that knows if the work actually finished” |
| [r/AI_Agents](https://www.reddit.com/r/AI_Agents/) | General agent builders | Harness, not another chat agent |
| [r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/) | Local / OSS agent CLIs | Provider-agnostic scheduler + sandbox |
| [r/selfhosted](https://www.reddit.com/r/selfhosted/) | Local daemons, login services, no SaaS | `service install`, morning pack, privacy |
| [r/SelfHostedAI](https://www.reddit.com/r/SelfHostedAI/) | Self-hosted AI automation | Overnight jobs on your box |
| [r/commandline](https://www.reddit.com/r/commandline/) | CLI craft audience | Deterministic `add` contract, `guide --json` |
| [r/opensource](https://www.reddit.com/r/opensource/) | MIT tools looking for users | Feedback request + roadmap |
| [r/node](https://www.reddit.com/r/node/) / [r/javascript](https://www.reddit.com/r/javascript/) | npm install path | `npm i -g omnishpilot` show HN-style |

Also watch niche showcases that already host similar tools (Night Watch, Jazz,
Codeman-style posts): same communities upvote “I built X, please break it.”

## Posting norms that work

1. **Disclose** you are the author in the first lines.  
2. **One concrete demo** — doctor → add --now --follow → progress.  
3. **Ask for specific feedback** (sandbox on macOS, Windows schtasks, UX of `add`).  
4. **Link** npm + GitHub issues; avoid affiliate / waitlist spam.  
5. Stagger posts over days; tailor the hook per sub (don’t crosspost identical text).  
6. Engage every critique in-thread; fold fixes into the next release.

## Draft hook (adapt per sub)

> I got tired of scheduled agent jobs that show green but did nothing — approval
> prompts, rate limits, hangs, no acceptance check. OmnishPilot is a free local
> harness: queue a job, run any agent CLI (or a shell command) unattended inside
> a sandbox, follow progress, optional notify when done.
>
> `npm i -g omnishpilot && omnishpilot doctor && omnishpilot start -d`
>
> Looking for people to try overnight CI triage / research briefs and tell me
> what breaks. MIT — https://github.com/labKnowledge/omnishpilot-cli

## Beyond Reddit

- Hacker News “Show HN” (weekend, concrete demo in comment 1)  
- [skills.sh](https://skills.sh) via publishing the skill repo (`npx skills add …`)  
- Discord/Slack: Cursor, Claude Code, LocalLLaMA community servers (read rules first)  
- Dev.to / Hashnode long-form: “Why cron is the wrong model for agents”
