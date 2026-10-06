# Xraylarch-web agent guide

Read `AGENTS.md` for API operation, scientific conventions, and project-specific
working rules. For code changes, also read `README.md` and `CONTEXT.md`.

This repository uses the Mac-local shared memory bridge for Claude, Codex, and Pi.
Its project ID is `xraylarch-web`; its canonical memory directory is
`~/.local/share/claude-project-memory/xraylarch-web/memory/`. The repository and
Claude native-memory directories are not alternate writable memory stores.

At session start, run the exact `memoryctl load` command supplied by the bridge
bootstrap. Read its full index and relevant topic notes before project mutation.
If no bootstrap was supplied, request one with `memoryctl context --repo "$PWD"
--writer codex --session SESSION-ID`, using the actual writer and session identity,
then run the exact command it returns.

Publish durable facts with `memoryctl begin`, edit only its staging paths, and
finish with `memoryctl commit`. Use the truthful `memoryctl no-op` path when no
durable fact changed. Never directly edit canonical topic files or `MEMORY.md`.
This project has no daily, weekly, or monthly report policy.

The complete bridge procedure and recovery guidance are in
`~/claude-tools/docs/shared-memory-bridge.md`. Run `memoryctl doctor --repo "$PWD"`
for diagnostics. Native Claude/Codex memory is disabled only for this registered
project. Shared project skills live in `.claude/skills`; `.agents/skills` links there.
