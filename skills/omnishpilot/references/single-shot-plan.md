# Single-shot plan (research → plan → build → prove)

For large goals that must finish in **one unattended run** (new feature,
scaffold, multi-file fix, small product slice).

## Phase 0 — Frame (5 minutes max)

Write into the job **output directory** as `plan.md`:

1. **Outcome** — one sentence the human will wake up to  
2. **Done-when** — observable checks (files exist, tests pass, UI path works)  
3. **Out of scope** — what you will not boil the ocean on  
4. **Risks** — auth, data, migrations, rate limits  

If the goal is already a single file tweak, skip to Phase 2 with a 3-line plan.

## Phase 1 — Research

- README, AGENTS.md, package manifests, existing patterns  
- Neighboring code that already solves half the problem  
- External facts only when the goal needs them (APIs, docs) — cite lightly  
- Do **not** invent metrics, citations, or APIs  

Capture findings as short bullets under `## Research` in `plan.md`.

## Phase 2 — Plan the work

Ordered steps. Each step must be:

- Small enough to verify  
- Dependent only on prior steps  
- Named by outcome (“auth redirect returns 302 to /home”), not chore (“edit file”)

Prefer a **vertical slice** that proves the outcome, then deepen.

## Phase 3 — Build

- Follow the plan; update checkboxes in `plan.md` as you go  
- Match existing voice/patterns in the repo  
- Absorb complexity in code; keep the user-facing surface simple  
- If the plan was wrong, revise `plan.md` once, then continue — do not thrash  

## Phase 4 — Prove

Before exiting:

1. Run the obvious verify commands (test / lint / build / deny-test as relevant)  
2. Ensure required artifacts exist (at least `result.md`)  
3. `result.md` must include:  
   - what changed  
   - how verified (commands + exit meaning)  
   - leftover risks / next human decisions  

Green status without proof is failure. OmnishPilot will re-queue on missing gates.

## Anti-patterns

- Starting to code before reading the workspace  
- Asking the user questions mid-run  
- Declaring done because the model “feels” finished  
- Huge speculative abstractions for a one-path feature  
- Copying marketing fluff into product UI
