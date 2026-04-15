# commit

Stage, compose, and push a commit. If releasing, analyzes the diff to propose the appropriate semver bump with rationale — user approves before anything is written.

## Steps

1. Run `git status` and `git diff HEAD` to understand what has changed.

2. Draft the commit message.

   **Format:** `<type>(<optional scope>): <subject>`

   | Type | Use when |
   |---|---|
   | `feat` | A new action, field, or user-visible capability |
   | `fix` | Correcting wrong behavior |
   | `refactor` | Restructuring internals with no behavior change |
   | `perf` | A measurable performance improvement |
   | `test` | Adding or fixing tests only |
   | `docs` | README, CONTRIBUTING, comments only |
   | `chore` | Dependency updates, build config, tooling |

   **Subject line** — imperative mood, lowercase, no period, ≤72 chars:
   - Good: `feat(slack): add post-message action`
   - Good: `fix: handle 429 rate-limit response from Gmail API`
   - Bad: `Updated the slack integration` (past tense, vague)
   - Bad: `feat: added new feature for sending messages to slack channels` (too long, redundant)

   **Body** (optional, separate from subject by a blank line) — use it when the *why* isn't obvious from the subject: explain the problem, the tradeoff made, or a non-obvious constraint. Skip it for self-evident changes.

   **Never stage** `node_modules/`, `dist/`, `.env`, `.DS_Store`, or anything in `.gitignore`. Stage `package-lock.json` when dependencies changed.

3. If bumping the version, analyze the diff since the last release tag to propose the correct bump:

   ```bash
   git describe --tags --abbrev=0
   git log <last-tag>..HEAD --oneline
   git diff <last-tag>..HEAD
   ```

   | Bump | When |
   |---|---|
   | **major** | Public API broken. Action `id` renamed/removed, required `inputFields` added, `outputFields` removed or renamed, `auth.type` changed, `defineIntegration` shape changed. Existing callers would break. |
   | **minor** | New capability, fully backwards-compatible. New actions, new optional fields, new auth options. |
   | **patch** | Bug fixes, internal refactors, dependency updates, docs — nothing a caller would notice. |

   Present the proposal and wait for approval before writing anything:

   ```
   Proposed: minor bump  →  1.1.0  →  1.2.0

   Rationale:
   - Added `discord.create-thread` action (new capability, backwards-compatible)
   - No existing actions or fields changed

   Approve? (or specify a different bump)
   ```

   After approval, bump `version` in `package.json` using `npm version <bump> --no-git-tag-version` and run `npm run build` to verify it compiles. The version bump is staged alongside the rest of the changes — the commit message describes the actual work, not the version bump.

4. Commit and push. Pushing to `main` is the deploy — `publish.yml` handles build, npm publish, tagging, and the GitHub release automatically. No separate step needed.

## Notes

- Never run `npm publish` manually.
- When in doubt between two bump levels, propose the more conservative one and explain why.
