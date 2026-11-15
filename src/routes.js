/**
 * The Web badge's channel to the host: one exact Fetch route on DSH's shared
 * `/api` channel (`ctx.connection.fetch.register`), behind the same login as
 * the rest of the Web UI. The page POSTs `{ sessionId }` and gets
 * `{ ok: true, value: { rummage } }`, where `rummage` is the newest status
 * object for that session or null.
 */

export const CHANNEL = '/api/dsh-rummage-recall'
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u

/**
 * @param {{ read: (sessionId: string) => Promise<object | null> }} status
 */
export function createRoutes(status) {
  return [
    {
      path: `${CHANNEL}/status`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let payload
        try {
          const text = await request.text()
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          return Response.json({ ok: false, error: { code: 'bad-request', message: 'The request body is not JSON.' } }, { status: 400 })
        }
        const sessionId = payload?.sessionId
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
          return Response.json({ ok: false, error: { code: 'bad-request', message: 'sessionId is missing or malformed.' } }, { status: 400 })
        }
        try {
          return Response.json({ ok: true, value: { rummage: await status.read(sessionId) } })
        } catch (error) {
          return Response.json({ ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } })
        }
      },
    },
  ]
}
