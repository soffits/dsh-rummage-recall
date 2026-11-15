# dsh-rummage-recall

Automatic recall for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Before a message you wrote reaches the model, the plugin asks [rummage](https://github.com/soffits/rummage) for a few leads from your own notes, mail and chats, and adds them right after your message. The model gets pointers it can follow (`rummage get <#id>`), not answers.

All the recall logic lives in `rummage recall --hook`, the same command Claude Code and Codex call from their prompt hooks. This plugin only decides which messages to recall for and where the reply goes.

## What it does

- Recalls for messages a person wrote: prompts from the Web UI, chat bridges such as the Telegram bot, and ACP editors. Scheduled job prompts, a subagent's brief, messages between agents, tool results and plugin notices are left alone.
- Runs `rummage recall --hook` with `{"prompt": ..., "session_id": ...}` on stdin. The session id lets rummage leave out the turns of the session you're in when it adds "said minutes ago in another session" items.
- Puts the reply in a user message (source kind `rummage-recall`) right after your message. Nothing goes into the system prompt, so prompt caching is unaffected.
- When recall is slow (`timeoutMs`), fails or finds nothing, the message goes on unchanged. A failure is logged once until recall works again.
- In the Web UI each recall shows as a row among the turn's work rows: `rummage recall · 3 leads · 180 ms`, which expands to the exact text the model got, or `no plausible match` / `skipped: timeout` / `skipped: error`. The skipped rows come from a log-only record that no model ever sees. Telegram and other bridges show nothing extra.

## Where the leads reach the model

- Native routes (OpenAI-compatible, Anthropic, DeepSeek...): a separate user message right after yours, in the same request.
- `claude-code` via [dsh-oh-my-claude](https://github.com/lcestou/dsh-oh-my-claude): the plugin sends Claude Code every user message after its last reply as one prompt, so the leads arrive in the same user turn as your words. A message you send while Claude is mid-turn goes to it straight away, before DSH's step hook runs; its leads follow with the next prompt.

## Requirements

- DeepSeek Harness 0.2.2 or later in the 0.2 line, Node 22+.
- rummage on the `PATH` of the DSH process (or set `command`), with an index. Keep `rummage daemon` running or use a rummage version that starts it on demand; without it recall matches exact words only.

## Install

From the Plugin Manager, install the bundle `@soffits/dsh-rummage-recall`. It adds no tools, so it loads into a running DSH without a restart. Reload the Web UI page to get the recall rows.

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
