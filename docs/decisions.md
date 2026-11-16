# Decisions

- Own plugin rather than DSH's Claude Code hooks bridge: the bridge runs on every step with every message (job prompts, agent relays, notices) and cannot tell a person's message from the rest.
- A person's message is a `user`-kind message whose recorded sender (`source.principal`) is not one of the agent kinds of the channel metadata contract (dsh-message-context); without a principal, one with a request id, or any `user`-kind message in a top-level session (ACP editors send neither); in a subagent's session that shape is the parent's brief. Only the structured sender is read, never sender lines in the text: recall sees live messages, and every channel records its sender as metadata.
- Leads go in their own user message right after the person's, with source kind `rummage-recall` and form `notice`: other readers (session titles, chat bridges, rummage's indexer) skip non-`user` kinds, and the person's own words stay unchanged.
- Several person messages entering one step get one recall over their joined text, placed after the last of them.
- A skipped recall is recorded as an ignorable plugin record so the Web UI can show it while no model sees it; it waits for the person's message to be committed so it sits after it in the log.
- The row sits in the turn's process disclosure (`groupTree: 'process'`): joining a step run put it under a generic "Analysis completed" header of its own.
- Failures log once per outage (reset by the next working recall), not once per process, so a later outage is still seen.
- Default timeout 3 s: the step waits for recall, and a recall that needs longer is better skipped.
- cwd and harness go in the hook JSON, not as CLI flags: Claude Code and Codex already send `cwd` there, so rummage reads it the same way from every harness, and an older rummage ignores the fields instead of failing on an unknown flag.
- Project registration and indexing happen inside `rummage recall --hook` when it gets a cwd, not as a second command per message: one process start per message instead of two.
- The badge polls the host (2 s while busy, 15 s otherwise, not in hidden tabs); the host refreshes lazily per request, so nothing runs while no page looks. A stream would add a long-lived channel for a value that changes every few seconds at most.
- Pause and resume are human slash commands (DSH `commands` service): they never reach the model and work from any client that offers commands.
