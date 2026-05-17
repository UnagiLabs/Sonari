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
3. Codex plan audit:
   - single pass by default
   - zero unresolved blocking items
   - rerun only if plan structure changed materially
4. User approval:
   - exactly one approval gate before implementation
5. Issue update:
   - approved plan appended to issue body
6. Implementation:
   - TDD per step
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
8. Fresh-context reviewer:
   - `verification_reviewer` runs read-only
   - reviewer explicitly uses `$code-review`
   - gate review stays focused on blocking/high issues only
   - no more than 3 findings
   - no unresolved blocking items
9. PR:
   - issue link
   - test results
   - concise summary
10. Cleanup and final report:
   - `manage-worktree.sh remove` was executed after PR creation
   - target worktree no longer appears in `git worktree list`
   - target feature branch no longer appears in `git branch --list`
   - final user report was sent only after cleanup completed
