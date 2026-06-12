# Workflow Checklist

Use this checklist while running `implement-codex-plan`.

This skill implements an existing plan. It does NOT plan, audit, or seek plan approval.

1. Preflight:
   - `gh auth status`
   - repo root and worktree status
2. Locate and read the plan:
   - explicit plan path, else `.codex/prompts/issue-<number>.md`, else pasted plan body
   - stop if none can be found
3. Understand the plan:
   - target issue number, goal, completion criteria
   - user-confirmed design decisions
   - allowed scope and out-of-scope
   - files/symbols to check first
   - verification commands
4. Plan-vs-reality sanity check (lightweight, before broad edits):
   - confirm the plan's key files/symbols still match the codebase
   - if materially conflicting, STOP and report to the user; do not re-plan
5. Worktree:
   - created under `.codex/state/worktrees/`
   - this location overrides any worktree path written in the plan
   - stop if the worktree path or branch already exists
6. Implementation (faithful to the plan):
   - only files within the plan's allowed scope
   - follow user-confirmed design decisions exactly
   - TDD per step
   - fast path for tiny/low-risk steps; `issue_step_worker` for multi-step/multi-layer/high-risk
   - each step ends with exactly one dedicated commit
   - worktree is clean before the next step starts
   - every commit message is generated via `$draft-commit-message`
   - progress reported per step
7. Local verification:
   - run the plan's verification commands first
   - available `check`
   - available `test`
   - `check:move` when Move files / Move.toml / Move.lock changed
   - available `build` when needed
8. Codex `/review`:
   - a clean-context subagent runs the default Codex CLI `/review` command
   - `/review` uses PR-style comparison: implementation branch against `main`
   - review context includes plan goal summary, implementation summary, validation results, changed files, current branch, base branch, and `git diff --stat main...HEAD`
   - unresolved blocking or high-confidence correctness/security/regression findings stop PR creation
   - advice, nits, and low-confidence findings are either fixed or documented as follow-up / validation gaps in the PR body
   - local verification is rerun after review fixes
   - `/review` runs once by default
   - `/review` is rerun at most once, only after high-risk changes or large blocking review fixes
9. PR:
   - created with `$prepare-pr`
   - issue link
   - results against the plan's completion criteria + test results
   - concise summary
10. Cleanup and final report:
    - `git -C <worktree-path> status --short` was empty before cleanup
    - `git worktree remove <worktree-path>` was executed after PR creation
    - `git branch -d feature/issue-<number>-<slug>` was executed for the local branch
    - target worktree no longer appears in `git worktree list`
    - target feature branch no longer appears in `git branch --list`
    - remote branch was left in place for the PR
    - final user report was sent only after cleanup completed

Do NOT:

- re-plan, audit the plan, seek plan approval, or write the plan back to the issue body
- invoke `issue_planner`, `plan_reviewer`, or `gh-issue-implement`
- widen or shrink the plan's scope on your own
- batch multiple steps into a single commit
- hand-write commit messages (always `$draft-commit-message`)
