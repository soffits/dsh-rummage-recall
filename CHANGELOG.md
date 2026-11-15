# Changelog

## 0.2.0

- The hook input carries the session's working directory (`cwd`) and `harness: "dsh"`, so rummage can pick the project scope.
- Rummage's `rummage` status object from each reply (scope, index progress, pause) is kept on the leads message or skip record and shown in the row.
- A memory badge above the composer while the project's index is being built, paused or failed, or memory is paused.
- `/rummage-pause [recall|index|all] [2h]` and `/rummage-resume` commands.

## 0.1.0

- First release: recall for every message a person writes through `rummage recall --hook`, the leads added as a user message right after it, a Web UI row per recall (leads, no match, timeout, error), settings for sources, budgets and timeout.
