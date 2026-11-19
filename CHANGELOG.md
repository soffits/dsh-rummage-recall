# Changelog

## 0.3.0

- The pictures sent with a message go to rummage as `images` (file paths in DSH's attachment store, up to four), so recall can search with them (rummage 0.30 adds items whose pictures look alike to the leads, without delaying the leads the words find). A message of only pictures is recalled for too; before, it had no words and was skipped. An older rummage ignores the field.
## 0.2.2

- A prompt another agent sent through a client (a session's brief, a scheduled job's prompt, an outside script) no longer counts as a person's message: the recorded sender (`source.principal`) decides, and its agent kinds are skipped. Sender lines in the text are no longer parsed; channels record the sender as metadata.

## 0.2.1

- Work with rummage 0.16: the row shows the scope name and the badge shows a memory pause (rummage sends `scope` and `paused` as objects, which 0.2.0 ignored).
- `/rummage-pause` and `/rummage-resume` use rummage's slash-command hook (`pause --hook`), so `recall 2h`, `here`, `private` and the rest are read by rummage; before, a duration made `rummage pause` fail with a usage error.
- The badge asks `rummage status --line --json` without the unsupported `--session` option, so it works between messages, and does not repeat a pause already in rummage's status line.

## 0.2.0

- The hook input carries the session's working directory (`cwd`) and `harness: "dsh"`, so rummage can pick the project scope.
- Rummage's `rummage` status object from each reply (scope, index progress, pause) is kept on the leads message or skip record and shown in the row.
- A memory badge above the composer while the project's index is being built, paused or failed, or memory is paused.
- `/rummage-pause [recall|index|all] [2h]` and `/rummage-resume` commands.

## 0.1.0

- First release: recall for every message a person writes through `rummage recall --hook`, the leads added as a user message right after it, a Web UI row per recall (leads, no match, timeout, error), settings for sources, budgets and timeout.
