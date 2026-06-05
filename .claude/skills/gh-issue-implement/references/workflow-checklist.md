# Workflow Checklist

Use this checklist while running `gh-issue-implement`.

1. Preflight:
   - `gh auth status`
   - repo root and worktree status
2. Plan:
   - phase and step split
   - references/step-design.md format
   - acceptance criteria
   - verification plan
3. Plan audit:
   - single pass by default (`plan-reviewer` subagent, read-only)
   - zero unresolved blocking items
   - rerun only if plan structure changed materially
4. User approval:
   - exactly one approval gate before implementation
5. Issue update:
   - approved plan appended to issue body
6. Implementation:
   - TDD per step (`issue-step-worker` subagent)
   - progress reported with phase/step context
   - bounded edits per step
   - each step ends with exactly one dedicated commit
   - worktree is clean before the next step starts
   - every commit message is generated via `draft-commit-message`
7. Local verification:
   - available `check`
   - available `typecheck`
   - available `test`
   - available `build` when needed
8. Final review (`verification-reviewer`):
   - a fresh-context `verification-reviewer` subagent runs the review using the `code-review` skill rubric
   - the review uses PR-style comparison: implementation branch against `main`
   - review context includes issue summary, implementation summary, validation results, changed files, current branch, base branch, and `git diff --stat main...HEAD`
   - unresolved blocking or high-confidence correctness/security/regression findings stop PR creation
   - advice, nits, and low-confidence findings are either fixed or documented as follow-up / validation gaps in the PR body
   - local verification is rerun after review fixes
   - the review runs once by default
   - the review is rerun at most once, only after high-risk changes or large blocking review fixes
9. PR:
   - issue link
   - test results
   - concise summary
10. Cleanup and final report:
   - the worktree was removed (`ExitWorktree` or `git worktree remove`) after PR creation
   - target worktree no longer appears in `git worktree list`
   - target feature branch no longer appears in `git branch --list` (a branch pushed for the PR may remain on the remote)
   - final user report was sent only after cleanup completed
