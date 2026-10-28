# OmnishPilot CLI

[![npm](https://img.shields.io/npm/v/omnishpilot.svg)](https://www.npmjs.com/package/omnishpilot)
[![Node](https://img.shields.io/node/v/omnishpilot.svg)](https://www.npmjs.com/package/omnishpilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**npm package:** [`omnishpilot`](https://www.npmjs.com/package/omnishpilot)  
**Repository:** [github.com/labKnowledge/omnishpilot-cli](https://github.com/labKnowledge/omnishpilot-cli)  
**Issues:** [github.com/labKnowledge/omnishpilot-cli/issues](https://github.com/labKnowledge/omnishpilot-cli/issues)

Free **autonomy harness** for heavy agent work: schedule jobs, run any local/OSS agent CLI **unattended inside a sandbox**, failover on rate limits, track runs, and get notified when work finishes.

Works on **Linux**, **macOS**, and **Windows** (Node **18+**). Sandbox isolation is strongest on Linux with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`).

> Vendor routines (Claude cowork/routines, Cursor Automations) optimize for *simple* jobs and still hit approval walls or single-vendor lock-in. OmnishPilot trades simplicity for **possibility**: complex jobs that must complete alone, with your machine’s agents, contained by your sandbox.

---

## Install (npm)

Global CLI (recommended):

```bash
npm install -g omnishpilot
omnishpilot doctor
omnishpilot sandbox deny-test
omnishpilot start -d
```

Or run without a global install:

```bash
npx omnishpilot doctor
npx omnishpilot start -d
```

| | |
|--|--|
| Package name | `omnishpilot` |
| Binaries | `omnishpilot`, `agentboard` (alias) |
| Registry | https://registry.npmjs.org/omnishpilot |
| Current line | see badge / `npm view omnishpilot version` |

After install, config and data default to `~/.omnishpilot` (override with `OMNISHPILOT_HOME`). First run: `omnishpilot config init` if you want an explicit scaffold.

**Linux autonomy:** install bubblewrap so sandboxed unattended runs work:

```bash
sudo apt install bubblewrap   # Debian/Ubuntu
omnishpilot sandbox check
```

---

## Install from source (this repo)

```bash
git clone https://github.com/labKnowledge/omnishpilot-cli.git
cd omnishpilot-cli
bash install.sh          # npm install + sync runtime + link → ~/.local/bin
omnishpilot doctor
omnishpilot start -d
```

Manual:

```bash
npm install && npm run sync
npm link                 # or: ln -sfn "$PWD/bin/omnishpilot.js" ~/.local/bin/omnishpilot
```

### Monorepo note

Upstream development also lives under the [AgentBoard](https://github.com/labKnowledge/AgentBoard) monorepo (`omnishpilot-cli/` folder). This repository is the **publishable npm package** (self-contained `runtime/`). Prefer this repo for installs and issues; use AgentBoard when hacking the live server next to other AgentBoard apps.

```bash
# From AgentBoard checkout
npm run cli:link
# or: cd omnishpilot-cli && bash install.sh
```

---

## Quick ops

```bash
omnishpilot doctor
omnishpilot sandbox status
omnishpilot sandbox deny-test
omnishpilot capabilities
omnishpilot start -d
omnishpilot service install      # start on login (systemd / LaunchAgent / schtasks)
omnishpilot watch                # live dashboard
omnishpilot watch <job-id>       # follow a job log
omnishpilot watch --log          # follow daemon log
omnishpilot add "research competitor pricing into a one-pager"
omnishpilot dashboard
omnishpilot stop
```

API commands **auto-start** the daemon when it is not running. Disable with `--no-autostart` or `OMNISHPILOT_NO_AUTOSTART=1`.

---

## Sandbox (required for autonomy)

Unattended agents use skip-permissions / `--yolo` flags via `agent-run`. That is only safe inside isolation.

| Backend | When |
|---------|------|
| **bwrap** (default on Linux) | Host FS read-only; workspace + HOME writable; `~/.ssh` / `~/.aws` / … masked |
| docker / firejail | Fallbacks when `backend: auto` and bwrap is missing |
| none | Only if `sandbox.enabled=false` or `requireForAutonomous=false` (unsafe) |

```bash
omnishpilot sandbox check      # exit 1 if autonomous gate fails
omnishpilot sandbox deny-test  # prove outside writes fail
```

Config (`sandbox` in `omnishpilot.config.json`):

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Wrap agent-run in the sandbox |
| `backend` | `auto` | `auto` \| `bwrap` \| `docker` \| `firejail` \| `none` |
| `network` | `true` | Agents need model APIs; set `false` to cut egress |
| `requireForAutonomous` | `true` | Refuse bare YOLO if sandbox unhealthy |
| `hidePaths` | ssh/aws/gnupg/kube/docker | tmpfs masks over sensitive dirs |
| `extraBindRw` | `[]` | Extra RW mounts |

---

## Why this CLI

| Capability | Status |
|------------|--------|
| Any agent on PATH (Cursor, Claude, OSS via agent-run) | **have** |
| Unattended flags (no Approve-on-every-tool) | **have** |
| OS sandbox around those runs | **have** (Linux bwrap) |
| Schedule + watch + supervisor heartbeat | **have** |
| Omnish notify / file delivery | **have** |
| Agent failover + rate-limit cooldown | **have** |
| Acceptance gates (tests/artifacts vs clicks) | planned |
| Git worktree isolation per run | planned |
| Verifier agent before ship | planned |
| Webhook triggers (GitHub/Linear) | planned |

See `omnishpilot capabilities` and [`docs/capabilities.md`](./docs/capabilities.md).

---

## Service (login)

| OS | Mechanism |
|----|-----------|
| Linux | `systemd --user` unit `omnishpilot.service` |
| macOS | LaunchAgent `tech.eligapris.omnishpilot` |
| Windows | Scheduled task `OmnishPilot` (ONLOGON) |

```bash
omnishpilot service install
omnishpilot service status
omnishpilot service logs
omnishpilot service uninstall
```

---

## Package layout

```
omnishpilot-cli/
  bin/omnishpilot.js     # npm bin entry
  lib/                   # CLI (platform, daemon, service, watch, client)
  runtime/               # bundled server + public UI (shipped on npm)
  scripts/sync-runtime.js
  omnishpilot.config.example.json
  docs/                  # public docs (capabilities); strategy notes stay local / gitignored
```

`npm pack` / `prepack` runs `npm run sync` so `runtime/` is complete before publish. In an AgentBoard monorepo checkout, `lib/bootstrap.js` prefers the parent `server/` for live edits.

---

## Env

| Variable | Purpose |
|----------|---------|
| `OMNISHPILOT_HOME` | Config + data directory |
| `OMNISHPILOT_PACKAGE_ROOT` | App root containing `server/` + `public/` |
| `OMNISHPILOT_HOST` / `OMNISHPILOT_PORT` | CLI client target |
| `OMNISHPILOT_NO_AUTOSTART` | Disable auto daemon start |

---

## Publish (maintainers)

```bash
cd omnishpilot-cli
npm run check
npm run sync
npm version patch   # or minor / 0.6.x
npm publish         # public package `omnishpilot` on npmjs.com
```

Requires npm auth with publish rights to `omnishpilot`.

---

## Links

| | URL |
|--|-----|
| npm | https://www.npmjs.com/package/omnishpilot |
| Source | https://github.com/labKnowledge/omnishpilot-cli |
| Issues | https://github.com/labKnowledge/omnishpilot-cli/issues |
| Related monorepo | https://github.com/labKnowledge/AgentBoard |

## License

MIT — free tool. See [LICENSE](./LICENSE).
