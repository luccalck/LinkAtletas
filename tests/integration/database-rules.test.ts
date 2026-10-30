import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from '../../server/db/pool.js'
import { migrate } from '../../server/db/migrate.js'

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://linkatletas:linkatletas_dev@127.0.0.1:54329/linkatletas_test'
const target = new URL(url)
if (!decodeURIComponent(target.pathname).endsWith('_test')) {
  throw new Error('Regras do banco exigem PostgreSQL isolado com sufixo _test.')
}

let pool: Pool
let client: PoolClient | undefined
let athlete: string, coach: string, otherCoach: string, otherAthlete: string, admin: string, contract: string
let fixtureUsers: string[] = []

function db() {
  if (!client) throw new Error('Conexao de teste indisponivel.')
  return client
}

beforeAll(async () => {
  pool = createPool(url)
  await migrate(pool)
})

afterAll(async () => { await pool?.end() })

beforeEach(async () => {
  client = await pool.connect()
  ;[athlete, coach, otherCoach, otherAthlete, admin] = Array.from({ length: 5 }, () => randomUUID())
  fixtureUsers = [athlete, coach, otherCoach, otherAthlete, admin]
  await client.query('BEGIN')
  for (const [id, role] of [[athlete, 'athlete'], [coach, 'coach'], [otherCoach, 'coach'], [otherAthlete, 'athlete'], [admin, 'admin']]) {
    await client.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [id, 'Teste regras', `${id}@example.invalid`, 'fixture', role])
  }
  contract = (await client.query("INSERT INTO contracts(athlete_id,coach_id,status) VALUES($1,$2,'active') RETURNING id", [athlete, coach])).rows[0].id
  await client.query('COMMIT')
  await client.query('BEGIN')
})

afterEach(async () => {
  if (!client) return
  try {
    await client.query('ROLLBACK')
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [fixtureUsers])
  } finally {
    client.release()
    client = undefined
  }
})

const message = (sender: string, contractId = contract) => db().query(
  'INSERT INTO messages(contract_id,sender_id,body_ciphertext) VALUES($1,$2,$3) RETURNING id,athlete_id,coach_id',
  [contractId, sender, 'fixture'],
)

async function payment() {
  const subscription = (await db().query("INSERT INTO billing_subscriptions(contract_id,plan_name,amount_cents,commission_bps,environment) VALUES($1,'Teste',1000,1000,'sandbox') RETURNING id", [contract])).rows[0].id
  return (await db().query("INSERT INTO billing_payments(subscription_id,provider_payment_id,amount_cents,net_cents,status,event_at) VALUES($1,$2,1000,900,'RECEIVED',now()) RETURNING id", [subscription, randomUUID()])).rows[0].id as string
}

describe('papeis e participantes preservados pelo PostgreSQL', () => {
  it.each(['athlete_id', 'coach_id'])('recusa papel incorreto no campo %s ao criar contrato', async (field) => {
    const values = field === 'athlete_id' ? [otherCoach, coach] : [athlete, otherAthlete]
    await expect(db().query('INSERT INTO contracts(athlete_id,coach_id) VALUES($1,$2)', values)).rejects.toMatchObject({ code: '23503', constraint: `contracts_${field === 'athlete_id' ? 'athlete' : 'coach'}_role_fkey` })
  })

  it.each(['athlete_id', 'coach_id'])('recusa alterar %s para usuario com papel incorreto', async (field) => {
    await expect(db().query(`UPDATE contracts SET ${field}=$1 WHERE id=$2`, [field === 'athlete_id' ? otherCoach : otherAthlete, contract])).rejects.toMatchObject({ code: '23503' })
  })

  it.each(['athlete_id', 'coach_id'])('recusa administrador no campo %s do contrato', async (field) => {
    await expect(db().query('INSERT INTO contracts(athlete_id,coach_id) VALUES($1,$2)', [field === 'athlete_id' ? admin : athlete, field === 'coach_id' ? admin : coach])).rejects.toMatchObject({ code: '23503' })
  })

  it.each(['athlete', 'coach'])('recusa trocar papel de %s vinculado a contrato', async (role) => {
    await expect(db().query("UPDATE users SET role='admin' WHERE id=$1", [role === 'athlete' ? athlete : coach])).rejects.toMatchObject({ code: '23503' })
  })

  it('permite trocar papel quando nao ha contrato dependente', async () => {
    expect((await db().query("UPDATE users SET role='athlete' WHERE id=$1", [otherCoach])).rowCount).toBe(1)
  })

  it.each(['athlete', 'coach'])('aceita mensagem do %s e deriva participantes sem alterar o INSERT da API', async (role) => {
    expect((await message(role === 'athlete' ? athlete : coach)).rows[0]).toMatchObject({ athlete_id: athlete, coach_id: coach })
  })

  it.each(['athlete', 'coach', 'admin'])('recusa mensagem de %s que nao participa do contrato', async (role) => {
    await expect(message(role === 'athlete' ? otherAthlete : role === 'coach' ? otherCoach : admin)).rejects.toMatchObject({ code: '23514', constraint: 'messages_sender_participant' })
  })

  it('recusa trocar remetente para terceiro', async () => {
    const id = (await message(athlete)).rows[0].id
    await expect(db().query('UPDATE messages SET sender_id=$1 WHERE id=$2', [admin, id])).rejects.toMatchObject({ code: '23514', constraint: 'messages_sender_participant' })
  })

  it('recusa mover mensagem para contrato em que remetente nao participa', async () => {
    const next = (await db().query('INSERT INTO contracts(athlete_id,coach_id) VALUES($1,$2) RETURNING id', [otherAthlete, otherCoach])).rows[0].id
    const id = (await message(athlete)).rows[0].id
    await expect(db().query('UPDATE messages SET contract_id=$1 WHERE id=$2', [next, id])).rejects.toMatchObject({ code: '23514', constraint: 'messages_sender_participant' })
  })

  it('permite mover mensagem quando remetente participa do contrato de destino', async () => {
    const next = (await db().query('INSERT INTO contracts(athlete_id,coach_id) VALUES($1,$2) RETURNING id', [athlete, otherCoach])).rows[0].id
    const id = (await message(athlete)).rows[0].id
    await db().query('UPDATE messages SET contract_id=$1 WHERE id=$2', [next, id])
    expect((await db().query('SELECT athlete_id,coach_id FROM messages WHERE id=$1', [id])).rows[0]).toEqual({ athlete_id: athlete, coach_id: otherCoach })
  })

  it('recusa forjar copias de participantes para autorizar terceiro', async () => {
    const id = (await message(athlete)).rows[0].id
    await expect(db().query('UPDATE messages SET sender_id=$1,athlete_id=$1 WHERE id=$2', [otherAthlete, id])).rejects.toMatchObject({ code: '23503', constraint: 'messages_contract_members_fkey' })
  })

  it('recusa alterar participantes se isso invalidaria remetente existente', async () => {
    await message(coach)
    await expect(db().query('UPDATE contracts SET coach_id=$1 WHERE id=$2', [otherCoach, contract])).rejects.toMatchObject({ code: '23514', constraint: 'messages_sender_participant' })
  })

  it('permite alterar participante quando todos os remetentes continuam validos', async () => {
    await message(athlete)
    await db().query('UPDATE contracts SET coach_id=$1 WHERE id=$2', [otherCoach, contract])
    expect((await db().query('SELECT coach_id FROM messages WHERE contract_id=$1', [contract])).rows[0]).toEqual({ coach_id: otherCoach })
  })

  it('preserva soft-delete, anonimizar mensagem e encerramento de contrato', async () => {
    const id = (await message(coach)).rows[0].id
    await db().query("UPDATE users SET name='Conta encerrada',email=$1,disabled_at=now() WHERE id=$2", [`${randomUUID()}@example.invalid`, coach])
    await db().query("UPDATE contracts SET status='cancelled',ended_at=now() WHERE id=$1", [contract])
    await db().query("UPDATE messages SET body_ciphertext='',read_at=now() WHERE id=$1", [id])
    expect((await db().query('SELECT body_ciphertext FROM messages WHERE id=$1', [id])).rows[0]).toEqual({ body_ciphertext: '' })
  })

  it('preserva exclusao em cascata dos usuarios e contratos', async () => {
    const id = (await message(athlete)).rows[0].id
    await db().query('DELETE FROM users WHERE id=$1', [coach])
    expect((await db().query('SELECT id FROM messages WHERE id=$1', [id])).rows).toEqual([])
    expect((await db().query('SELECT id FROM contracts WHERE id=$1', [contract])).rows).toEqual([])
  })

  it('recusa mensagem para contrato inexistente com erro de chave estrangeira', async () => {
    await expect(message(athlete, randomUUID())).rejects.toMatchObject({ code: '23503', constraint: 'messages_contract_members_fkey' })
  })
})

describe('valores financeiros coerentes com eventos recebidos', () => {
  it.each(['amount_cents', 'net_cents', 'coach_share_cents', 'platform_share_cents'])('recusa %s negativo em pagamento', async (column) => {
    const id = await payment()
    await expect(db().query(`UPDATE billing_payments SET ${column}=-1 WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514', constraint: 'billing_payments_nonnegative' })
  })

  it('recusa split negativo', async () => {
    const id = await payment()
    await expect(db().query("INSERT INTO billing_splits(provider_split_id,payment_id,wallet_id,amount_cents,status,event_at) VALUES($1,$2,'fixture',-1,'DONE',now())", [randomUUID(), id])).rejects.toMatchObject({ code: '23514', constraint: 'billing_splits_nonnegative' })
  })

  it.each(['REFUNDED', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE'])('aceita %s com valores positivos e splits zerados', async (status) => {
    const id = await payment()
    await db().query('UPDATE billing_payments SET status=$1,coach_share_cents=810,platform_share_cents=90 WHERE id=$2', [status, id])
    expect((await db().query("INSERT INTO billing_splits(provider_split_id,payment_id,wallet_id,amount_cents,status,event_at) VALUES($1,$2,'fixture',0,'REFUNDED',now())", [randomUUID(), id])).rowCount).toBe(1)
  })

  it('aceita pagamento totalmente zerado sem inventar minimo financeiro', async () => {
    const id = await payment()
    expect((await db().query('UPDATE billing_payments SET amount_cents=0,net_cents=0,coach_share_cents=0,platform_share_cents=0 WHERE id=$1', [id])).rowCount).toBe(1)
  })
})

describe('indices dos filtros reais das filas e limpeza', () => {
  it('mantem indices parciais somente para mensagens e eventos pendentes', async () => {
    const result = await db().query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[])", [['mail_outbox_pending_delivery', 'billing_events_pending_processing', 'password_resets_expiry']])
    const definitions = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef as string]))
    expect(definitions.mail_outbox_pending_delivery).toMatch(/\(next_attempt_at, created_at\).*WHERE.*sent_at IS NULL.*attempts < 5/)
    expect(definitions.billing_events_pending_processing).toMatch(/\(next_attempt_at, received_at\).*WHERE.*processed_at IS NULL/)
    expect(definitions.password_resets_expiry).toContain('(expires_at)')
    expect(definitions.password_resets_expiry).not.toContain('WHERE')
  })

  it('consulta filas com os filtros do worker sem incluir enviados, esgotados ou futuros', async () => {
    const mailIds: string[] = []
    for (const [attempts, sent, future] of [[0, false, false], [5, false, false], [0, true, false], [0, false, true]]) {
      mailIds.push((await db().query("INSERT INTO mail_outbox(user_id,recipient,subject,encrypted_body,attempts,sent_at,next_attempt_at) VALUES($1,'fixture@example.invalid','Teste','fixture',$2,CASE WHEN $3 THEN now() ELSE NULL END,now()+CASE WHEN $4 THEN interval '1 day' ELSE interval '-1 day' END) RETURNING id", [athlete, attempts, sent, future])).rows[0].id)
    }
    const pending = await db().query('SELECT id FROM mail_outbox WHERE id=ANY($1::uuid[]) AND sent_at IS NULL AND attempts<5 AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED', [mailIds])
    expect(pending.rows).toEqual([{ id: mailIds[0] }])
    const eventIds = Array.from({ length: 3 }, () => randomUUID())
    for (const [index, id] of eventIds.entries()) {
      await db().query("INSERT INTO billing_events(id,event,event_at,payload,processed_at,next_attempt_at) VALUES($1,'PAYMENT_RECEIVED',now(),'{}',CASE WHEN $2 THEN now() ELSE NULL END,now()+CASE WHEN $3 THEN interval '1 day' ELSE interval '-1 day' END)", [id, index === 1, index === 2])
    }
    expect((await db().query('SELECT id FROM billing_events WHERE id=ANY($1::text[]) AND processed_at IS NULL AND next_attempt_at<=now() ORDER BY received_at LIMIT 100', [eventIds])).rows).toEqual([{ id: eventIds[0] }])
  })

  it('limpa somente tokens com expiracao anterior ao prazo de retencao', async () => {
    const ids = Array.from({ length: 3 }, () => randomUUID())
    for (const [index, id] of ids.entries()) {
      await db().query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3::interval)", [id, athlete, ['-2 days', '-1 hour', '1 hour'][index]])
    }
    const removed = await db().query("DELETE FROM password_resets WHERE token_hash=ANY($1::text[]) AND expires_at<now()-interval '1 day' RETURNING token_hash", [ids])
    expect(removed.rows).toEqual([{ token_hash: ids[0] }])
  })
})

async function waitForBlock(pid: number) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])
    if (result.rows[0].blocked) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Operacao concorrente nao aguardou o bloqueio esperado.')
}

async function raceAgainstCommit(sql: string, values: string[], expectedCodes: string[]) {
  const concurrent = await pool.connect()
  try {
    await concurrent.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const pid = (await concurrent.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    const result = concurrent.query(sql, values).then(() => ({ code: 'accepted' }), (error: { code: string }) => ({ code: error.code }))
    await waitForBlock(pid)
    await db().query('COMMIT')
    expect(expectedCodes).toContain((await result).code)
  } finally {
    await db().query('ROLLBACK')
    await concurrent.query('ROLLBACK')
    concurrent.release()
  }
}

describe('integridade entre transacoes concorrentes', () => {
  it('impede trocar papel enquanto outro contrato e confirmado', async () => {
    await db().query('INSERT INTO contracts(athlete_id,coach_id) VALUES($1,$2)', [athlete, otherCoach])
    await raceAgainstCommit("UPDATE users SET role='athlete' WHERE id=$1", [otherCoach], ['23503', '40001'])
  })

  it('impede contrato com papel alterado em transacao concorrente', async () => {
    await db().query("UPDATE users SET role='athlete' WHERE id=$1", [otherCoach])
    await raceAgainstCommit('INSERT INTO contracts(athlete_id,coach_id) VALUES($1,$2)', [athlete, otherCoach], ['23503', '40001'])
  })

  it('impede remover participante enquanto mensagem dele e confirmada', async () => {
    await message(coach)
    await raceAgainstCommit('UPDATE contracts SET coach_id=$1 WHERE id=$2', [otherCoach, contract], ['23514', '40001'])
  })

  it('impede mensagem de participante removido em transacao concorrente', async () => {
    await db().query('UPDATE contracts SET coach_id=$1 WHERE id=$2', [otherCoach, contract])
    await raceAgainstCommit('INSERT INTO messages(contract_id,sender_id,body_ciphertext) VALUES($1,$2,$3)', [contract, coach, 'fixture'], ['23514', '40001'])
  })
})
