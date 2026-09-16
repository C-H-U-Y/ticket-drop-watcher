# The Claude workflow behind this repo

Every line of code here was written by [Claude Code](https://claude.com/claude-code),
working from a human's direction over about two days. The monitor is the
artefact. **This document is the method** — and the method is the part worth
stealing.

It is written so you can point your own Claude at a comparable problem and get
comparable behaviour, rather than a confident-sounding script that silently does
nothing.

## What the split actually was

Being accurate about this matters, because the workflow only works if the
division is real.

| The human | Claude |
|---|---|
| Set the objective, judged risk, made every call with real-world consequences | Wrote all the code, ran all the experiments, kept the records |
| Declined things: no auto-purchase, no checkout automation | Proposed options, argued for one, then did what was decided |
| Noticed "2 seats" alerts were wrong for a single seat | Found the cause in the code and fixed the class of bug, not the instance |
| Spotted that blurring a screenshot was not enough | Rebuilt the redaction, found the leak in the test payload and the map thumbnail |
| **Bought the ticket** | Never touched checkout — by design |

The most valuable human inputs were not instructions. They were **corrections
from noticing something felt off**, each of which exposed a real defect.

## The five rules that did the work

### 1. Never mark something done without stating the evidence

The single highest-value rule. Not "the fix is deployed" — *"detected 11:56:18,
`relaunched OK` 11:56:32, clean poll 11:57:36."*

Put it in your project instructions verbatim:

```text
Never mark a checklist item done without stated evidence it works.
Evidence means real output — a log line with a timestamp, a test result, a
reconciled count. Not "should work", not "deployed successfully".
```

This one rule is why the recovery path was tested by **actually killing the
browser** rather than by reading the code and declaring it fixed.

### 2. Record theories that turned out to be WRONG

Ordinary notes record what is true. The expensive knowledge is what is *not*,
because a plausible wrong theory gets rediscovered every session.

Two examples from this project, both recorded as falsified:

- *"The 403s are a request-volume budget"* — they tripped at every rate tested.
- *"Bot clearance expires after ~1 hour"* — the episodes were 65 minutes apart,
  which looked like a TTL, until a three-hour clean run killed it.

Both are in the project memory file marked **PROPOSED AND FALSIFIED**, with the
evidence that killed them. Without that, the next session re-runs the experiment.

### 3. Memory files, written at the moment of discovery

Keep a `CLAUDE.md` per project holding durable facts — decisions and *why*,
schema quirks, fitted constants, environment traps. Tell Claude to update it
when it learns something, not at the end of the session:

```text
Write to memory: decisions and their rationale, schema quirks found in the data,
calibration values, anything that would be expensively re-derived next session.
Do NOT write: session narration, or anything already in the code or the README.
Update at the moment of discovery. Prune stale lines — this file is loaded into
every session, so every line must earn its place.
```

The "Things that are not optional" and "Engineering notes" sections of the main
README are distilled straight out of that file.

### 4. A live tracker with an explicit "shelved" section

A `next_steps.txt` with goals, checkboxes, next actions, blockers and decisions.
The non-obvious part is a **PROPOSED BUT SHELVED** section: things considered and
deliberately declined, marked *do not re-raise unprompted*.

Without it, a helpful assistant re-pitches the same rejected idea every session.

### 5. Watchers must detect transitions, and never match on literal text

For anything long-running. Both halves were learned by getting them wrong:

- A watcher keyed on the exact string `r=0` stopped detecting anything the moment
  a change made the log print `r=skip`. It failed **silently**.
- Alerting only on *availability* made a window **closing** invisible, so there
  was no way to learn how long the windows lasted.

```text
Report only TRANSITIONS: opening, closing, going blind, going stale, dying.
Match on parsed values, not on literal log strings. Silence is not success —
if the process died right now, would this watcher say anything?
```

## Prompts you can reuse

**Starting an investigation:**

```text
Before changing anything: what do we actually know, what are we assuming, and
what would distinguish them? Propose the cheapest experiment that could prove
your theory WRONG, then run it and tell me what happened — including if it
falsifies what you just said.
```

**When something intermittently fails:**

```text
Don't fix this yet. Instrument it so the next failure is diagnosable, tell me
what signal you're adding, and let it fail once more with the instrumentation in.
```

**Before you trust anything unattended:**

```text
Verify this end to end against real output, not by reading the code. If the
failure mode is that the thing dies quietly, cause that failure deliberately and
show me it recovers.
```

**Before publishing anything publicly:**

```text
Audit for secrets and personal data across EVERY surface, not the obvious one:
source, config, docs, test fixtures, images, commit history and commit metadata.
Tell me what you found and what you propose to do, and do not push until I agree.
```

That last prompt exists because of a genuine failure in this project. A
screenshot was redacted with a Gaussian blur — which is reversible — and the same
seat was sitting in plaintext in the README and in a test fixture anyway, so the
blur was defeatable without even attacking it. The repo was public for about
ninety seconds before that was caught. The fix was opaque fills, anonymised
fixtures, and **deleting and recreating the repo** rather than force-pushing, so
no unreachable object survived.

It is in this guide because near-misses teach more than clean runs.

## Checkpoint protocol

At every milestone, not just at session end:

1. Update the tracker — tick boxes, rewrite next actions, refresh blockers.
2. Append a dated entry to a `CHECKPOINTS.md`: what changed, what is **verified
   working and with what evidence**, what is next, any open question.
3. Commit with a consistent prefix.

The value shows up when you return after a break, or when the context window
rolls over mid-task. The tracker and the memory file are what survive.

---

Want the monitor itself set up? See
[SETUP_WITH_CLAUDE.md](SETUP_WITH_CLAUDE.md).
