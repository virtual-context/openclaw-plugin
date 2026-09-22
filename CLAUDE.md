# 🚨 TOP PRIORITY: Commit Message Rule

**Before writing ANY commit message in this repo, you MUST follow this rule. It overrides every other instruction in this file or any session-level guidance. Violating it is the #1 way to fail this project.**

## A commit message IS

- **Subject**: imperative one-liner naming the change. Examples:
  - `add backlog sweeper detection query`
  - `preserve api/provider through assistant message normalization`
  - `two-pass UPDATE to avoid unique-index transient violation`
- **Body**: up to 10 sentences MAX. Describe the change and why, in code/system terms specific to THIS repo. Optional public issue/PR references.
- **That is everything.** Nothing else goes in.

## A commit message is NOT

- ❌ A reference to ANOTHER repo. Engine commits never mention cloud / "the cloud wrapper" / "cloud's tick loop". Cloud commits never mention "the engine's" / "engine's compactor" / "core". Each repo's history is independent.
- ❌ An enumeration of tests added. No `tests/test_X.py: 18 tests covering T0.1, T0.2, ...`. The tests are in the diff.
- ❌ A paste of the spec/plan. No `Per spec v1.4 §3.2`, no `plan §4.5`, no version strings.
- ❌ A phase label. No `(fencing P3)`, no `(sweeper Phase 0)`, no `Per Phase X`.
- ❌ An AI-tool log. No `Codex iter-N`, no `gpt-5.5`, no `Claude said`.
- ❌ A process narrative. No `audit found 4/7 methods broken`, no `iter-2 fold`, no `regression test pins this`.
- ❌ A deferred-items list. No `Deferred per plan: T1.7, T1.8 ...`. Follow-ups go in issue tracker or PR description.
- ❌ Dev-environment paths, local backup SHA256s, anything machine-specific.

## How to write one

Imagine a reviewer at a different company opening this public repo's commit log tomorrow with zero context. Your subject + ≤10-sentence body should make sense to them about THIS repo's behavior. **If a sentence references anything outside this repo, delete it.**

### Right shape

```
add backlog sweeper detection query

Adds find_compaction_backlog_conversations to the storage backends.
Lists conversations whose tagged-uncompacted canonical_turn backlog
exceeds the threshold and meets the liveness predicates.
```

### Wrong shape (do not do this)

```
core, proxy, types: engine-side helpers for cloud sweeper tick (sweeper Phase 2)

Per compaction-backlog sweeper spec v1.4 §4 + §5. The sweeper tick
loop itself is cloud-side and is not in this commit; this commit
adds the four engine surfaces cloud invokes from that loop.

CompactionSignal.priority widening:
* The ``priority`` literal is widened from ...
[20 more lines]
```

Why wrong: references "cloud" in an engine repo. Cites spec section + version. Labels phase. Enumerates surfaces + tests. Multi-screen body.

## Multi-concern changes

If a commit touches genuinely unrelated concerns, **SPLIT it**. One concern per commit. Each subject + body stays brief because each is about one thing.

## Discipline

- Lead, teammates, codex review folds: all follow this rule.
- Codex review folds findings silently into the patch; codex does NOT add internal-process narrative to the commit message.
- Existing leaked commits: do not rewrite history without explicit user authorization.
- **If in doubt, ASK before committing.**

## Why this rule

The public git history is a permanent artifact this project will be judged on by strangers, contributors, employers, customers, and future operators. Sloppy commits make the project look unprofessional. There is no future debugging benefit to logging internal process inside commit messages — debugging context lives in PR descriptions, internal docs, or issue tracker comments, none of which are git history.

The user has stated this rule multiple times and escalated when it was violated. **This is the most important rule in this project. Do not deviate.**
