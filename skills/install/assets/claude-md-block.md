<!-- ORCHESTRATOR:START -->
## Orchestrated work (orchestrator)

This project uses the orchestrator plugin. Every main session, in the main checkout or in any worktree, follows the `orchestrator:orchestrate` skill. Stories follow the `orchestrator:stories` skill.

- **Product state:** `{{STORIES_DIR}}/map.md` (generated). Stories: `{{STORIES_DIR}}/stories/`. Decisions: `{{STORIES_DIR}}/decisions/`.
- **Plugs:** `.orchestrator.json`. **Ledger:** shared by every session, outside git; the session start names its path. **Locked tests:** `.orchestrator/locked-tests.txt`.
- **Done means:** `{{FULL_VERIFICATION_COMMANDS}}` all pass, and `node {{STORIES_DIR}}/stories.mjs --tests --check` passes.
- **Tests cannot prove:** {{RUNNER_LIMIT}} The human reviews these.
- **Test naming:** {{TEST_NAMING_CONVENTION}}
- **Seams:** {{SEAMS_ONE_LINE_EACH}}
- **Delegation:** {{HARNESS_STATUS: Agent-tool subagents; the browser tool for UI checks, or none. Measured on this machine: ...}}
- **Hooks on this machine:** {{HOOKS_STATUS}}
<!-- ORCHESTRATOR:END -->

### Lessons

_(none yet: only real failures in this project add lessons here)_
