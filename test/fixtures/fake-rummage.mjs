#!/usr/bin/env node
// Stands in for `rummage recall --hook`. Behaviour comes from the prompt it is given:
//   "slow"  sleeps 5 s, "crash" exits 2, "garbage" prints non-JSON, "nothing" prints nothing,
//   anything else answers with two leads that echo the prompt, the session id and the arguments.
let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', async () => {
  const event = JSON.parse(raw || '{}')
  const prompt = String(event.prompt ?? '')
  if (process.env.FAKE_RUMMAGE_LOG) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.FAKE_RUMMAGE_LOG, `${JSON.stringify({ event, argv: process.argv.slice(2) })}\n`)
  }
  if (prompt.includes('slow')) await new Promise((r) => setTimeout(r, 5000))
  if (prompt.includes('crash')) {
    process.stderr.write('boom\n')
    process.exit(2)
  }
  if (prompt.includes('garbage')) return void process.stdout.write('not json\n')
  if (prompt.includes('nothing')) return
  const text = [
    'Recalled from the user\'s own files by rummage; possibly related leads.',
    `- #aaaa111111 · vault · notes/a.md:1-4 · 2026-11-15 · "A" · prompt=${prompt}`,
    '  snippet',
    `- #bbbb222222 · dsh · dsh:${event.session_id}#3 · 2026-11-15 · "B" · args=${process.argv.slice(2).join(' ')}`,
  ].join('\n')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) + '\n')
})
