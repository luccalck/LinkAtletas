import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { createPool } from '../../server/db/pool.js'
import { migrate } from '../../server/db/migrate.js'

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://linkatletas:linkatletas_dev@127.0.0.1:54329/linkatletas_test'
if (!decodeURIComponent(new URL(url).pathname).endsWith('_test')) throw new Error('Integridade exige banco com sufixo _test.')
let pool: Pool
let client: PoolClient
let athlete: string, coach: string, otherCoach: string, contract: string

beforeAll(async () => {
  pool = createPool(url)
  await migrate(pool)
})
afterAll(async () => { await pool?.end() })
beforeEach(async () => {
  client = await pool.connect()
  await client.query('BEGIN')
  athlete = randomUUID()
  coach = randomUUID()
  otherCoach = randomUUID()
  for (const [id, role] of [[athlete, 'athlete'], [coach, 'coach'], [otherCoach, 'coach']]) {
    await client.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [id, 'Teste integridade', `${id}@example.invalid`, 'fixture', role])
  }
  contract = (await client.query("INSERT INTO contracts(athlete_id,coach_id,status,decided_at) VALUES($1,$2,'active',now()) RETURNING id", [athlete, coach])).rows[0].id
})
afterEach(async () => {
  try { await client.query('ROLLBACK') } finally { client.release() }
})

describe('integridade fisica dos relacionamentos', () => {
  const review = (reviewCoach: string) => client.query('INSERT INTO reviews(contract_id,athlete_id,coach_id,rating,body) VALUES($1,$2,$3,5,$4)', [contract, athlete, reviewCoach, 'Avaliacao de teste'])

  it('aceita avaliacao dos participantes do contrato', async () => {
    expect((await review(coach)).rowCount).toBe(1)
  })

  it('rejeita avaliacao com treinador existente que nao pertence ao contrato', async () => {
    await expect(review(otherCoach)).rejects.toMatchObject({ code: '23503', constraint: 'reviews_contract_members_fkey' })
  })

  it('impede trocar participantes de contrato que possui avaliacao', async () => {
    await review(coach)
    await expect(client.query('UPDATE contracts SET coach_id=$1 WHERE id=$2', [otherCoach, contract])).rejects.toMatchObject({ code: '23503' })
  })

  it('recusa comissao de assinatura fora do limite definido nas regras financeiras', async () => {
    await expect(client.query("INSERT INTO billing_subscriptions(contract_id,plan_name,amount_cents,commission_bps,environment) VALUES($1,'Teste',100,5001,'sandbox')", [contract])).rejects.toMatchObject({ code: '23514', constraint: 'billing_subscriptions_commission_bounds' })
  })

  it('possui indice de apoio na primeira coluna de todas as FKs', async () => {
    const missing = await client.query(`SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL AND i.indkey[0]=ANY(c.conkey))`)
    expect(missing.rows).toEqual([])
  })
})
