import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { createPool } from '../../server/db/pool.js'
import { runScheduledJobs } from '../../server/scheduled.js'

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://linkatletas:linkatletas_dev@127.0.0.1:54329/linkatletas_test'
if (!decodeURIComponent(new URL(url).pathname).endsWith('_test')) throw new Error('Teste de trava exige banco com sufixo _test.')
let pool: Pool
beforeAll(() => { pool = createPool(url) })
afterAll(async () => { await pool.end() })

describe('trava das tarefas com servicos externos', () => {
  it('preserva a exclusao mutua durante espera externa maior que o timeout ocioso geral', async () => {
    const lease = await pool.connect()
    const observer = await pool.connect()
    lease.on('error', () => {})
    const isolated = { connect: async () => lease } as unknown as Pool
    let handedOff = false
    try {
      await lease.query("SET idle_in_transaction_session_timeout='500ms'")
      handedOff = true
      const result = await runScheduledJobs(isolated, async () => {
        await delay(750)
        const blocked = await observer.query('SELECT pg_try_advisory_xact_lock(128712027) AS locked')
        expect(blocked.rows[0].locked).toBe(false)
        expect((await lease.query("SELECT current_setting('idle_in_transaction_session_timeout') AS timeout")).rows[0].timeout).toBe('5min')
        return { completed: true }
      })
      expect(result).toEqual({ skipped: false, result: { completed: true } })
      expect((await observer.query('SELECT pg_try_advisory_xact_lock(128712027) AS locked')).rows[0].locked).toBe(true)
    } finally {
      if (!handedOff) lease.release()
      observer.release()
    }
  })
})
