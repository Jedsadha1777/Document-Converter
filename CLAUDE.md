# Hard rules

## Skills check — mandatory BEFORE any action

Before responding to any request that involves action (code edit, file write, command run, design proposal, bug fix), you MUST:

1. **List files under `skills/`** (project root). Identify which ones might apply:
   - `using-superpowers` — read FIRST (how to find/use skills)
   - `systematic-debugging` — ANY bug / unexpected behavior / "doesn't work" report
   - `verification-before-completion` — before claiming "fixed" / "done" / "should work"
   - `brainstorming` — "what should we do" / open-ended design questions
   - `writing-plans` + `executing-plans` — multi-step work
   - `test-driven-development` — adding features with clear behavior to test
   - `using-git-worktrees`, `dispatching-parallel-agents`, etc. — when topic matches
2. **Read** the relevant skill file(s) end-to-end with the Read tool (NOT skim).
3. **Announce**: "Read skills [X, Y, …] — applying [process]".
4. **Follow** the skill's process literally — checklist phases, iron laws, red flags.

Failing to do this step = override the user. If you catch yourself mid-action without having done it, STOP, revert, start over with the check.

**This is non-negotiable.** Locked. Even for "simple" / "obvious" fixes. Track record shows skipping = thrashing fixes that introduce new bugs (3+ rounds on UI work that should have been one).

Even if a skill seems redundant with what you already know — read it. Knowing the concept ≠ using the skill.

## Memory check — mandatory before any non-trivial action

Before proposing a solution, editing a file, or running a non-read-only command, you MUST:

1. **Scan MEMORY.md headlines** (the project-level auto-memory index loaded into context).
2. **Explicitly state**: "Checked MEMORY.md — applicable rules: [list], or NONE because [reason]."
3. Only THEN propose / edit / act.

Failing to do this step = override the user. If you catch yourself mid-action without having done it, STOP, revert, and start over with the check.

This is non-negotiable. The check is cheap (memory is already in your context). Skipping it has cost you the user's trust before — track record shows you propose solutions that directly contradict memory entries already loaded.

## Adding new memory — restraint

Do not save a new memory entry every time you make a mistake. That is theater, not learning:
- More entries = MEMORY.md grows → attention dilutes → existing rules get skipped more.
- Saving a memory feels like "addressing the problem" without behavior change.

Save a new memory ONLY when:
- The user explicitly asks you to remember.
- The lesson does not overlap with any existing entry.
- The lesson is concrete enough to act on (not a vague "be more careful").

If the lesson overlaps with an existing entry, UPDATE that entry instead of adding a new one.

## When user says "ลบ" / "delete" / "remove" / "ไม่ต้อง" / "พอ"

Delete literally. Do not reframe as "fix / replace / improve / consolidate". Do not insert anything you previously proposed that the user already rejected.
