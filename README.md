<p align="center">
  <img src="brand/logo-512.png" alt="OmnishPilot" width="128" height="128" />
</p>

<h1 align="center">OmnishPilot</h1>

<p align="center"><strong>Wake to proof, not hope.</strong></p>

<p align="center">
  Close the laptop. Come back to finished work — not a “success” that did nothing.
</p>

<p align="center"><em>Free · local · yours</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/omnishpilot"><img src="https://img.shields.io/npm/v/omnishpilot.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/omnishpilot"><img src="https://img.shields.io/node/v/omnishpilot.svg" alt="Node version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
</p>

---

## Why people use it

Scheduled agents promised overnight work. What most people got was **babysitting**: approval popups, hangs, rate limits, and green checks with empty folders.

OmnishPilot is for a simpler belief: **if the work is worth doing, it should finish alone — and prove it.**

| You want… | You get… |
|-----------|----------|
| To set it once and walk away | Jobs that keep going without you watching |
| To trust the morning | A clear result you can open — not a wall of logs |
| Tools you already have | Uses the AI helpers already on your computer |
| Something anyone can try | Plain commands. One install. No cloud account for the harness |

Works on **Windows**, **Mac**, and **Linux**. Stays on **your** machine.

Short command after install: **`omnip`** (same as `omnishpilot`).

### Hand it to your AI, you stay on what matters

You don’t have to learn every flag. After install, **give OmnishPilot to the AI you already chat with** (Cursor, Claude, ChatGPT with a terminal, and friends) and say something like:

> I installed OmnishPilot (`omnip`). Help me plan tomorrow and schedule the heavy work so it finishes while I’m away. Use `omnip guide` if you need the commands.

The agent can check your machine, suggest a day plan, and set the schedule for you. **You decide what matters. It handles the queue.**

That’s the point: stop spending attention on *when* and *how* the work runs. Spend it on judgment, people, and the work only you can do.

Already live in ClickUp (or a similar task list)? Tell your agent:

> Look at my ClickUp tasks. Pick what can finish overnight, schedule them with OmnishPilot (`omnip`), and leave me proof when I wake up.

You wake up to **done work**, not another list waiting for you.

---

## Get started in 5 minutes

You need [Node.js 18+](https://nodejs.org/) (LTS is fine). That’s it for a first try.

### Step 1 — Install

```bash
npm install -g omnishpilot
```

You now have **`omnip`** (and `omnishpilot` — same tool).

### Step 2 — Check your machine

```bash
omnip doctor
```

Fix anything it flags in plain language (missing pieces, permissions). Run it again until it looks ready.

### Step 3 — Leave it running in the background

```bash
omnip start -d
```

This is the engine that **actually runs your jobs** while you’re away. The optional dashboard gives you a window into what is happening.

**Best for “close the laptop and forget”:** also install the login service so it comes back after reboot:

```bash
omnip service install
```

Tip: if you skip step 3, many commands will start the engine for you when you type them — but for overnight schedules, keep it running with `start -d` or `service install`.

### Step 4 — Run your first job

Pick one. Copy, paste, go.

**A. Something useful right now** (finishes while you watch the first time):

```bash
omnip add --now --follow "Write a short result.md that summarizes what this computer is for and what I should do next"
```

**B. Something that runs every morning:**

```bash
omnip add --daily 09:00 "Triage what needs my attention today and write result.md with the top three items"
```

**C. A simple reminder-style command** (no AI — just your terminal on a schedule):

```bash
omnip add --command --daily 08:00 "echo Good morning > ~/omnishpilot-hello.txt"
```

### Step 5 — See that it worked

```bash
omnip tasks
omnip dashboard
```

Open the dashboard link it prints, or follow a job:

```bash
omnip follow <id>
```

You should leave with a **file or clear outcome** — proof, not hope.

---

## Everyday use (keep it this simple)

```bash
# One-shot soon
omnip add "Draft a one-page brief on X into result.md"

# Right now, wait until done
omnip add --now --follow "Fix the login bug in ~/my-app and write result.md"

# Every day / every hour
omnip add --daily 09:00 "…"
omnip add --hourly "…"

# Plain script or command (backups, health checks)
omnip add --command --daily 02:00 --workspace ~/data "./backup.sh"
```

Stuck? Ask for the short playbook — or ask your AI to run it:

```bash
omnip guide
```

**Prefer not to touch the terminal?** Tell your agent: *“Schedule my day with OmnishPilot”* and let it drive. You approve the plan; it runs the commands.

---

## Make it yours (optional)

| Need | Do this |
|------|---------|
| Open the friendly UI | `omnip open` or `omnip dashboard` |
| Set a UI password | `omnip password set 'your-secret'` |
| See live progress | `omnip watch` |
| Stop everything | `omnip stop` |
| Phone / chat ping when done | Install [Omnish](https://www.npmjs.com/package/omnish) separately, then `omnip notify-test` |

On Linux, for heavier AI jobs that must run without clicking “Allow”, install isolation once:

```bash
sudo apt install bubblewrap
omnip sandbox check
```

---

## Who it’s for

- People who want their **AI to plan and schedule the day**, not just chat about it
- Builders who want overnight work without babysitting
- Anyone who’d rather **focus on what matters** and let the queue run alone

You don’t need to become a scheduler expert. Install once, hand OmnishPilot to your AI, and keep your attention where it counts.

---

## Help

```bash
omnip guide
omnip doctor
omnip help
```

Package: [npmjs.com/package/omnishpilot](https://www.npmjs.com/package/omnishpilot) · command: **`omnip`**  
License: MIT — free · local · yours
