# dsh-rummage-recall

Automatic recall for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Before a message you wrote reaches the model, the plugin asks [rummage](https://github.com/soffits/rummage) for a few leads from your own notes, mail and chats, and adds them right after your message. The model gets pointers it can follow (`rummage get <#id>`), not answers.

All the recall logic lives in `rummage recall --hook`, the same command Claude Code and Codex call from their prompt hooks. This plugin only decides which messages to recall for and where the reply goes.

## What it does

- Recalls for messages a person wrote: prompts from the Web UI, chat bridges such as the Telegram bot, and ACP editors. Scheduled job prompts, a subagent's brief, messages between agents, tool results and plugin notices are left alone.
- Runs `rummage recall --hook` with `{"prompt", "session_id", "cwd", "harness": "dsh"}` on stdin, the same shape Claude Code and Codex hooks send, plus `images` (the files of the pictures sent with the message, read from DSH's attachment store) when there are some: rummage 0.30 or later also searches with them and adds items whose pictures look alike. A message of only a picture is recalled for too. The session id lets rummage leave out the turns of the session you're in; the session's current working directory picks the project scope.
- Puts the reply in a user message (source kind `rummage-recall`) right after your message. Nothing goes into the system prompt, so prompt caching is unaffected.
- When recall is slow (`timeoutMs`), fails or finds nothing, the message goes on unchanged. A failure is logged once until recall works again.
- In the Web UI each recall shows as a row among the turn's work rows: `rummage recall · my-project · 3 leads · 180 ms`, which expands to the exact text the model got, or `no plausible match` / `skipped: timeout` / `skipped: error`. When rummage reports index progress or a pause, the row adds it. The skipped rows come from a log-only record that no model ever sees.
- A small "Memory" badge above the composer shows while rummage is still indexing the project, has paused memory, or hit an error, and disappears once the index is complete. It reads the status rummage returned with the last recall and, between messages, asks `rummage status --line --json` only when the index's progress file changed or the last answer is getting old.
- `/rummage-pause [recall|index|all] [2h]` and `/rummage-resume` pause and resume memory (they run `rummage pause|resume --hook` with your words, the session and its folder, and show rummage's answer). Commands never reach the model.
- Telegram and other chat bridges show nothing extra.

## Where the leads reach the model

- Native routes (OpenAI-compatible, Anthropic, DeepSeek...): a separate user message right after yours, in the same request.
- `claude-code` via [dsh-oh-my-claude](https://github.com/lcestou/dsh-oh-my-claude): the plugin sends Claude Code every user message after its last reply as one prompt, so the leads arrive in the same user turn as your words. A message you send while Claude is mid-turn goes to it straight away, before DSH's step hook runs; its leads follow with the next prompt.

## How it talks to rummage

The hook reply is `{"hookSpecificOutput": {"additionalContext": "..."}, "rummage": {...}}`. The leads text goes to the model as is. The optional `rummage` object (scope, `index` with `state`, `line`, `note`, `error`, `file`, and `paused`) is only for display: it is kept on the leads message or the skip record and drives the row and the badge. An older rummage that ignores `cwd` and sends no `rummage` object still works; there's just no scope or badge.

## Requirements

- DeepSeek Harness 0.2.2 or later in the 0.2 line, Node 22+.
- rummage on the `PATH` of the DSH process (or set `command`), with an index. Keep `rummage daemon` running or use a rummage version that starts it on demand; without it recall matches exact words only.

## Install

```sh
dsh plugin --profile web add @soffits/dsh-rummage-recall
```

or install the bundle `@soffits/dsh-rummage-recall` from the Plugin Manager. It adds no tools, so it loads into a running DSH without a restart. Reload the Web UI page to get the recall rows.

The plugin only runs `rummage`, so rummage has to work on its own first, on the machine DSH runs on:

```sh
uv tool install 'git+https://github.com/soffits/rummage'
rummage setup        # downloads the embedding model, about 330 MB
```

Give it something to remember in `~/.config/rummage/config.toml` (here a folder of Markdown notes; the other source types are in [rummage's README](https://github.com/soffits/rummage#configure)), index it, and call the hook the way the plugin does:

```toml
[sources.notes]
type = "markdown"
root = "~/notes"
```

```sh
rummage index
echo '{"prompt": "what did the lease say about my cat?", "session_id": "try", "cwd": "/home/me", "harness": "dsh"}' | rummage recall --hook
```

A lead comes back as `hookSpecificOutput.additionalContext` in the JSON. If that prints, the plugin has what it needs. The first hook call also makes rummage start remembering DSH's own chat history (its reply says so); `rummage pause` stops that, and `rummage sources` shows what it reads. A message with no matching lead goes on unchanged and the recall row says `no plausible match`.

`rummage` must be on the `PATH` of the DSH process. `uv tool install` puts it in `~/.local/bin`, which a DSH started as a service or from a desktop launcher may not have; then set `command` to the full path. When recall fails, the row says `skipped: error` and the DSH log has one line with the reason (`rummage-recall: recall failed (error): ...`), repeated only after it worked in between.

## Settings

Set them on the `rummage-recall` row in your profile patch:

```yaml
- id: rummage-recall
  config:
    sources: [vault, mail-personal]
    timeoutMs: 2000
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Recall for every message a person writes. |
| `command` | `rummage` | The rummage command, a name on `PATH` or a full path. |
| `sources` | `[]` | Only these rummage sources (`rummage sources` lists them); empty means all. |
| `maxItems` | `4` | Most leads per message. |
| `maxChars` | `1500` | Size budget of the leads block. |
| `timeoutMs` | `3000` | A slower recall is dropped and the message goes on without leads. |

## Privacy

Everything runs on your machine: the plugin starts a local process and reads its stdout. What rummage reads and returns is up to your rummage configuration (it masks credentials in its output by default).

## Development

`npm run check` and `npm test` run the unit tests. `node tools/e2e.mjs` boots a real DSH in a throwaway `DSH_HOME` under `.e2e/` with a scripted model and a stand-in rummage, and checks the whole path from prompt to model request.

## License

MIT
