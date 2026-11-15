# Maintainer notes

A DeepSeek Harness bundle: a host row on `agent/pre-step` that runs `rummage recall --hook` for messages a person wrote, plus a Web client half that draws each recall as a row. No tools. Users read `README.md`; this file and `docs/` are for whoever changes the code.

## Layout

- `index.js`: the host row. Config schema and the two listeners.
- `src/recall.js`: everything the host does, with no DSH imports (DSH's factories are passed in), so the tests run it on fakes: which messages count as a person's, the hook input, running the command, reading the reply, the leads message, the deferred skip record.
- `client.js`: the browser half, loaded by DSH's module loader (one self-contained file, only `react` required). A conversation Definition claims the leads message and the skip record; the row view copies the host's tool-row markup and CSS under the `drr-` prefix.
- `test/`: unit tests; `test/fixtures/fake-rummage.mjs` stands in for rummage (its behaviour follows words in the prompt).
- `tools/e2e.mjs`: a real DSH in a throwaway `DSH_HOME` under `.e2e/`, a scripted model, the fake rummage.

## Rules for changes

- Recall logic (what to return, ranking, budgets, masking, which prompts are worth recalling) belongs in rummage, not here. This plugin passes settings through and places the reply.
- The leads go into a user message, never the system prompt.
- The skip record is a plugin record (`plugin:rummage-recall/outcome`, ignorable) and is appended only after the person's message is in the log, outside that event's delivery.
- A recall that fails never blocks or changes the message; it logs once per outage.

## Checks

- `npm run check` and `npm test` run in CI on Node 22 and 24.
- `node tools/e2e.mjs` needs the `dsh` CLI on PATH and takes about half a minute; run it before a release that touches the host side. It never touches a real `DSH_HOME`; keep it that way.
- Client changes: look at the row in a real Web UI (a throwaway `dsh --profile web --no-open` with `DSH_HOME` set to a temp dir works) before releasing.

## Working on the project

- Everything in the repo is English.
- Ordinary implementation choices are yours: write the choice and a one-line reason in `docs/decisions.md`.
- Commit on a branch; merge, tag and publish only when the task asks for it.
