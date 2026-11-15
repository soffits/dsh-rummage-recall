/**
 * @soffits/dsh-rummage-recall: before a step that carries a person's message,
 * ask `rummage recall --hook` for leads from the user's own files and chats and
 * add them right after that message. See README.md.
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createRecall } from './src/recall.js'

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
  const recall = createRecall({
    config: () => config,
    createUserMessage,
    appendRecord: appendPluginRecord,
    warn: (line) => ctx.logger.warn(line),
  })
  ctx.on('agent/pre-step', (payload, next) => recall.preStep(payload, next))
  ctx.on('session/event', (session, event) => recall.onSessionEvent(session, event))
}
