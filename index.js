/**
 * @soffits/dsh-rummage-recall: before a step that carries a person's message,
 * ask `rummage recall --hook` for leads from the user's own files and chats and
 * add them right after that message. See README.md.
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createRecall } from './src/recall.js'
import { createStatus } from './src/status.js'
import { createRoutes } from './src/routes.js'

export const name = 'rummage-recall'

export const Config = z.object({
  enabled: z.boolean().default(true).description('Recall for every message a person writes.'),
  command: z.string().default('rummage').description('The rummage command (a name on PATH or a full path).'),
  sources: z.array(z.string()).default([])
    .description('Only these rummage sources (`rummage sources` lists them); empty means all.'),
  maxItems: z.natural().min(1).max(20).default(4).description('Most leads per message.'),
  maxChars: z.natural().min(200).max(20000).default(1500).description('Size budget of the leads block, in characters.'),
  timeoutMs: z.natural().min(100).max(60000).default(3000)
    .description('A recall slower than this is dropped and the message goes on without leads.'),
})

export function apply(ctx, config) {
  // The live directory (it changes with `working_directory`), else the one the session started in.
  const cwdOfSession = (session) => ctx.get('workingDirectory')?.get(session) ?? session?.header?.cwd
  const status = createStatus({
    config: () => config,
    cwdOf: (sessionId) => {
      const session = ctx.get('agents')?.get(sessionId)?.session
      return session === undefined ? undefined : cwdOfSession(session)
    },
  })
  const recall = createRecall({
    config: () => config,
    createUserMessage,
    appendRecord: appendPluginRecord,
    warn: (line) => ctx.logger.warn(line),
    cwdOf: (agent) => cwdOfSession(agent?.session),
    onMeta: status.remember,
  })
  ctx.on('agent/pre-step', (payload, next) => recall.preStep(payload, next))
  ctx.on('session/event', (session, event) => recall.onSessionEvent(session, event))

  // Pausing and resuming memory for the session a person types in; never sent to the model.
  ctx.inject(['commands'], (sub) => {
    sub.commands.register({
      name: 'rummage-pause',
      description: 'Pause rummage memory for this session (recall, index or all; optionally for a while, e.g. 2h)',
      input: { hint: '[recall|index|all] [2h]' },
      handler: ({ agent, rawInput }) => status.command('pause', String(agent.id), rawInput),
    })
    sub.commands.register({
      name: 'rummage-resume',
      description: 'Resume rummage memory for this session',
      handler: ({ agent, rawInput }) => status.command('resume', String(agent.id), rawInput),
    })
  })

  // The badge's status route; present only in hosts that serve the Web GUI.
  ctx.inject(['connection', 'webServer'], (sub) => {
    for (const route of createRoutes(status)) sub.connection.fetch.register(route)
  })
}
