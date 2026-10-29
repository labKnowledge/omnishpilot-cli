# OmnishPilot recipes

## Overnight CI triage

```bash
omnishpilot add --workspace ~/proj --daily 09:00 \
  --acceptance "result.md exists and lists failing checks" \
  "triage overnight CI failures; write result.md with causes and next steps"
```

## Fix a bug unattended

```bash
omnishpilot add --now --follow --workspace ~/proj \
  --agent auto \
  "fix the auth redirect; keep the change small; leave notes in result.md"
```

## Hourly health check (no agent)

```bash
omnishpilot add -c --hourly \
  "curl -fsS https://example.com/health >/dev/null"
```

## Nightly backup script

```bash
omnishpilot add --command --daily 02:00 --workspace ~/data \
  "./backup.sh"
```

## Weekly research brief

```bash
omnishpilot add --weekly mon 09:30 --agent claude \
  --acceptance "brief.md with sources" \
  "research competitor pricing changes this week into brief.md"
```

## Cap runaway agent spend

```bash
omnishpilot budget --minutes 180 --usd 20
omnishpilot budget --json
```

## Confirm sandbox before YOLO

```bash
omnishpilot sandbox check && omnishpilot sandbox deny-test
```

## Follow from another agent session

```bash
ID=$(omnishpilot add --now --json "…" | …parse id…)
omnishpilot follow "$ID" --timeout 3600
omnishpilot progress "$ID" --json
```
