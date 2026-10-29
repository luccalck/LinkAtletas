import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { runJobs } from './jobs.js'

export async function runScheduledJobs(
  pool: Pool,
  work: () => Promise<unknown> = () => runJobs(pool),
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5min'")
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(128712027) AS locked',
    )
    if (!rows[0]?.locked) return { skipped: true }
    return { skipped: false, result: await work() }
  } finally {
    try {
      await client.query('ROLLBACK')
      client.release()
    } catch (error) {
      client.release(true)
      throw error
    }
  }
}

export function scheduledRoutes(
  app: FastifyInstance,
  work: () => Promise<unknown>,
  secret: () => string | undefined = () => process.env.CRON_SECRET,
) {
  app.get('/api/internal/jobs', { schema: { hide: true } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const key = secret()
    const expected = Buffer.from(`Bearer ${key || ''}`)
    const actual = Buffer.from(req.headers.authorization || '')
    if (
      !key ||
      key.length < 32 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Acesso nao autorizado.' })
    return work()
  })
}
