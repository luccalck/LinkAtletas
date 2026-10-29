import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Socket } from 'node:net'
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Pool } from 'pg'
import type { AppUser } from '../../shared/contracts.js'
import type {
  InteractionEvent,
  Message,
} from '../../shared/interaction-contracts.js'
import { buildApp } from '../../server/app.js'
import { createPool } from '../../server/db/pool.js'
import { migrate } from '../../server/db/migrate.js'

const origin = 'http://localhost:5173'
function websocketSocket() {
  return Object.defineProperty(new Socket(), 'remoteAddress', { value: '127.0.0.1' })
}
const testUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://linkatletas:linkatletas_dev@127.0.0.1:54329/linkatletas_test'
if (!decodeURIComponent(new URL(testUrl).pathname).endsWith('_test'))
  throw new Error('Banco de interações deve terminar em _test.')
interface Actor {
  user: AppUser
  cookie: string
}
let pool: Pool, app: FastifyInstance
let athlete: Actor, coach: Actor, stranger: Actor, admin: Actor
let contractId: string,
  earlyId: string,
  reviewId: string,
  consultationId: string
let messages: Message[] = []
let oldReviewDays: string | undefined
const future = (minutes: number) =>
  new Date(Date.now() + (minutes + 1440) * 60_000).toISOString()
const futureStart = future(60)
async function request(
  actor: Actor | null,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url: `/api${url}`,
    headers: { origin, ...(actor ? { cookie: actor.cookie } : {}) },
    ...(payload === undefined
      ? {}
      : { payload: payload as Record<string, unknown> }),
  })
}
async function register(
  name: string,
  role: 'athlete' | 'coach',
): Promise<Actor> {
  const result = await request(null, 'POST', '/auth/register', {
    name,
    email: `${name.toLowerCase()}@interaction-test.local`,
    password: 'SenhaTeste123!',
    role,
  })
  expect(result.statusCode, result.body).toBe(201)
  return {
    user: result.json().user,
    cookie: `la_session=${result.cookies.find((c) => c.name === 'la_session')!.value}`,
  }
}
function success(response: { statusCode: number; body: string }, code = 200) {
  expect(response.statusCode, response.body).toBe(code)
}

describe.sequential('Comunicação, avaliações e agenda persistidas', () => {
  beforeAll(async () => {
    oldReviewDays = process.env.REVIEW_MIN_DAYS
    process.env.REVIEW_MIN_DAYS = '7'
    pool = createPool(testUrl)
    await migrate(pool)
    await pool.query('TRUNCATE users CASCADE')
    app = await buildApp({ pool, origin, logger: false })
    await app.ready()
    athlete = await register('AtletaChat', 'athlete')
    coach = await register('CoachChat', 'coach')
    stranger = await register('TerceiroChat', 'athlete')
    admin = await register('AdminChat', 'athlete')
    await pool.query("UPDATE users SET role='admin' WHERE id=$1", [
      admin.user.id,
    ])
    await pool.query(
      "UPDATE profiles SET verification_status='approved' WHERE user_id=$1",
      [coach.user.id],
    )
    contractId = (
      await pool.query(
        "INSERT INTO contracts(athlete_id,coach_id,status,decided_at) VALUES($1,$2,'active',now()-interval '10 days') RETURNING id",
        [athlete.user.id, coach.user.id],
      )
    ).rows[0].id
    earlyId = (
      await pool.query(
        "INSERT INTO contracts(athlete_id,coach_id,status,decided_at) VALUES($1,$2,'active',now()) RETURNING id",
        [stranger.user.id, coach.user.id],
      )
    ).rows[0].id
  })
  afterAll(async () => {
    if (oldReviewDays === undefined) delete process.env.REVIEW_MIN_DAYS
    else process.env.REVIEW_MIN_DAYS = oldReviewDays
    await app?.close()
    await pool?.end()
  })

  it('nega conversa a terceiro e visitantes, valida mensagem vazia e anexo alheio', async () => {
    expect(
      (await request(stranger, 'GET', `/contracts/${contractId}/messages`))
        .statusCode,
    ).toBe(404)
    expect(
      (await request(null, 'GET', `/contracts/${contractId}/messages`))
        .statusCode,
    ).toBe(401)
    expect(
      (
        await request(stranger, 'POST', `/contracts/${contractId}/messages`, {
          text: 'Acesso indevido.',
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await request(athlete, 'POST', `/contracts/${contractId}/messages`, {
          text: ' ',
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await request(athlete, 'POST', `/contracts/${contractId}/messages`, {
          mediaId: '11111111-1111-4111-8111-111111111111',
        })
      ).statusCode,
    ).toBe(400)
  })
  it('persiste mensagens cifradas, mantém ordem e pagina sem perda/duplicação', async () => {
    for (let index = 0; index < 5; index++) {
      const response = await request(
        athlete,
        'POST',
        `/contracts/${contractId}/messages`,
        { text: `Dado privado e persistente ${index}` },
      )
      success(response, 201)
      messages.push(response.json().message)
    }
    const stored = (
      await pool.query(
        'SELECT body_ciphertext FROM messages WHERE contract_id=$1',
        [contractId],
      )
    ).rows
    expect(stored).toHaveLength(5)
    expect(
      stored.every(
        (row) =>
          row.body_ciphertext.startsWith('la1:') &&
          !row.body_ciphertext.includes('Dado privado'),
      ),
    ).toBe(true)
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const response = await request(
        coach,
        'GET',
        `/contracts/${contractId}/messages?limit=2${cursor ? `&before=${cursor}` : ''}`,
      )
      success(response)
      const data = response.json()
      for (const message of data.messages) {
        expect(seen.has(message.id)).toBe(false)
        seen.add(message.id)
      }
      cursor = data.nextCursor
    } while (cursor)
    expect([...seen].sort()).toEqual(messages.map((m) => m.id).sort())
    const invalidCursor = await request(
      athlete,
      'GET',
      `/contracts/${earlyId}/messages?before=${messages[0].id}`,
    )
    expect(invalidCursor.statusCode).toBe(404)
    expect(
      (
        await request(
          coach,
          'GET',
          `/contracts/${earlyId}/messages?before=${messages[0].id}`,
        )
      ).statusCode,
    ).toBe(400)
  })
  it('confirma leitura até o cursor e conserva mensagens posteriores não lidas', async () => {
    success(
      await request(coach, 'PUT', `/contracts/${contractId}/messages/read`, {
        throughId: messages[1].id,
      }),
    )
    const list = (
      await request(athlete, 'GET', `/contracts/${contractId}/messages`)
    ).json().messages as Message[]
    expect(list.filter((m) => m.readAt)).toHaveLength(2)
    success(
      await request(coach, 'PUT', `/contracts/${contractId}/messages/read`, {}),
    )
    expect(
      (await request(athlete, 'GET', `/contracts/${contractId}/messages`))
        .json()
        .messages.every((m: Message) => !!m.readAt),
    ).toBe(true)
  })
  it('publica para duas sessões autenticadas após gravação e fecha sessão revogada', async () => {
    const coachEvents: InteractionEvent[] = [],
      athleteEvents: InteractionEvent[] = [],
      strangerEvents: InteractionEvent[] = []
    const coachSocket = await app.injectWS(
      '/api/events',
      { socket: websocketSocket(), headers: { cookie: coach.cookie, origin } },
      {
        onInit: (ws) =>
          ws.on('message', (raw) =>
            coachEvents.push(JSON.parse(raw.toString())),
          ),
      },
    )
    const athleteSocket = await app.injectWS(
      '/api/events',
      { socket: websocketSocket(), headers: { cookie: athlete.cookie, origin } },
      {
        onInit: (ws) =>
          ws.on('message', (raw) =>
            athleteEvents.push(JSON.parse(raw.toString())),
          ),
      },
    )
    const strangerSocket = await app.injectWS(
      '/api/events',
      { socket: websocketSocket(), headers: { cookie: stranger.cookie, origin } },
      {
        onInit: (ws) =>
          ws.on('message', (raw) =>
            strangerEvents.push(JSON.parse(raw.toString())),
          ),
      },
    )
    try {
      const sent = await request(
        athlete,
        'POST',
        `/contracts/${contractId}/messages`,
        { text: 'Mensagem realtime validada.' },
      )
      success(sent, 201)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(
        coachEvents.some(
          (e) =>
            e.type === 'message' && e.message.id === sent.json().message.id,
        ),
      ).toBe(true)
      expect(
        athleteEvents.some(
          (e) =>
            e.type === 'message' && e.message.id === sent.json().message.id,
        ),
      ).toBe(true)
      expect(strangerEvents.some((e) => e.type === 'message')).toBe(false)
      const closed = new Promise<number>((resolve) =>
        coachSocket.once('close', (code) => resolve(code)),
      )
      const coachSession = coach.cookie.slice('la_session='.length)
      const { tokenHash } = await import('../../server/shared/security.js')
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
        tokenHash(coachSession),
      ])
      success(
        await request(athlete, 'POST', `/contracts/${contractId}/messages`, {
          text: 'Sessão revogada não recebe isto.',
        }),
        201,
      )
      expect(await closed).toBe(1008)
      const login = await request(null, 'POST', '/auth/login', {
        email: coach.user.email,
        password: 'SenhaTeste123!',
      })
      success(login)
      coach.cookie = `la_session=${login.cookies.find((c) => c.name === 'la_session')!.value}`
    } finally {
      coachSocket.terminate()
      athleteSocket.terminate()
      strangerSocket.terminate()
    }
  })
  it('recusa upgrade WebSocket anônimo e com origem indevida', async () => {
    await expect(
      app.injectWS('/api/events', { socket: websocketSocket(), headers: { origin } }),
    ).rejects.toThrow('401')
    await expect(
      app.injectWS('/api/events', {
        socket: websocketSocket(),
        headers: { origin: 'https://invasor.example', cookie: athlete.cookie },
      }),
    ).rejects.toThrow('403')
  })
  it('notificações pertencem ao destinatário e não são marcadas por terceiros', async () => {
    const response = await request(coach, 'GET', '/notifications')
    success(response)
    expect(response.json().notifications.length).toBeGreaterThan(0)
    const target = response
      .json()
      .notifications.find((n: { readAt: string | null }) => !n.readAt)
    expect(target).toBeTruthy()
    success(
      await request(stranger, 'PUT', '/notifications', { ids: [target.id] }),
    )
    expect(
      (
        await pool.query('SELECT read_at FROM notifications WHERE id=$1', [
          target.id,
        ])
      ).rows[0].read_at,
    ).toBeNull()
    success(await request(coach, 'PUT', '/notifications', { all: true }))
    expect((await request(coach, 'GET', '/notifications')).json().unread).toBe(
      0,
    )
  })
  it('avalia apenas depois de sete dias e impede duplicação por vínculo', async () => {
    expect(
      (
        await request(stranger, 'POST', '/reviews', {
          contractId: earlyId,
          rating: 5,
          text: 'Ainda muito cedo para avaliar.',
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await request(coach, 'POST', '/reviews', {
          contractId,
          rating: 4,
          text: 'Treinador não avalia o atleta aqui.',
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await request(athlete, 'POST', '/reviews', {
          contractId,
          rating: 6,
          text: 'Fora da escala admitida.',
        })
      ).statusCode,
    ).toBe(400)
    const created = await request(athlete, 'POST', '/reviews', {
      contractId,
      rating: 4,
      text: 'Acompanhamento consistente e atencioso.',
    })
    success(created, 201)
    reviewId = created.json().review.id
    expect(
      (
        await request(athlete, 'POST', '/reviews', {
          contractId,
          rating: 5,
          text: 'Outra avaliação do mesmo ciclo.',
        })
      ).statusCode,
    ).toBe(409)
    const aggregate = (
      await request(athlete, 'GET', `/reviews?coachId=${coach.user.id}`)
    ).json()
    expect(aggregate).toMatchObject({ count: 1, average: 4 })
  })
  it('permite edição só ao autor e resposta só ao treinador avaliado', async () => {
    expect(
      (
        await request(stranger, 'PUT', `/reviews/${reviewId}`, {
          rating: 1,
          text: 'Tentativa de alterar relato alheio.',
        })
      ).statusCode,
    ).toBe(404)
    success(
      await request(athlete, 'PUT', `/reviews/${reviewId}`, {
        rating: 5,
        text: 'Acompanhamento excelente e ajustado.',
      }),
    )
    success(
      await request(coach, 'POST', `/reviews/${reviewId}/reply`, {
        text: 'Obrigado por compartilhar sua experiência.',
      }),
    )
    expect(
      (
        await request(athlete, 'GET', `/reviews?coachId=${coach.user.id}`)
      ).json().reviews[0].reply,
    ).toContain('Obrigado')
  })
  it('denúncia e moderação auditada removem todo conteúdo da publicação/média', async () => {
    success(
      await request(stranger, 'POST', `/reviews/${reviewId}/report`, {
        reason: 'Solicito revisão desta publicação.',
      }),
    )
    expect(
      (
        await request(athlete, 'PATCH', `/admin/reviews/${reviewId}`, {
          hidden: true,
          reason: 'Sem acesso administrativo.',
        })
      ).statusCode,
    ).toBe(403)
    success(
      await request(admin, 'PATCH', `/admin/reviews/${reviewId}`, {
        hidden: true,
        reason: 'Conteúdo sob análise da administração.',
      }),
    )
    expect(
      (await request(coach, 'GET', `/reviews?coachId=${coach.user.id}`)).json(),
    ).toMatchObject({ reviews: [], average: 0, count: 0 })
    expect(
      (
        await request(athlete, 'PUT', `/reviews/${reviewId}`, {
          rating: 5,
          text: 'Não restaurar conteúdo por edição.',
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await request(coach, 'POST', `/reviews/${reviewId}/reply`, {
          text: 'Não expor conteúdo oculto por resposta.',
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM review_moderation WHERE review_id=$1',
          [reviewId],
        )
      ).rows[0].count,
    ).toBe(1)
    const queue = await request(admin, 'GET', '/admin/reviews')
    success(queue)
    expect(queue.json().reports).toHaveLength(1)
  })
  it('agenda persistida cifra descrição e isola dados por vínculo', async () => {
    const created = await request(athlete, 'POST', '/consultations', {
      contractId,
      title: 'Revisão do planejamento',
      description: 'Informação privada da consultoria.',
      startsAt: futureStart,
      durationMinutes: 45,
    })
    success(created, 201)
    consultationId = created.json().consultation.id
    expect(created.json().consultation).toMatchObject({
      description: 'Informação privada da consultoria.',
      externalEventId: null,
      meetingUrl: null,
    })
    const stored = (
      await pool.query(
        'SELECT description_ciphertext FROM consultations WHERE id=$1',
        [consultationId],
      )
    ).rows[0].description_ciphertext
    expect(stored).not.toContain('Informação privada')
    expect(
      (await request(stranger, 'GET', '/consultations')).json().consultations,
    ).toHaveLength(0)
    expect(
      (await request(coach, 'GET', '/consultations')).json().consultations[0]
        .id,
    ).toBe(consultationId)
    expect(
      (
        await request(stranger, 'PATCH', `/consultations/${consultationId}`, {
          status: 'cancelled',
          reason: 'Não sou participante deste vínculo.',
        })
      ).statusCode,
    ).toBe(404)
  })
  it('bloqueia conflitos do treinador entre diferentes vínculos e horários passados', async () => {
    expect(
      (
        await request(stranger, 'POST', '/consultations', {
          contractId: earlyId,
          title: 'Conflito entre alunos',
          description: '',
          startsAt: futureStart,
          durationMinutes: 30,
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await request(athlete, 'POST', '/consultations', {
          contractId,
          title: 'Horário passado',
          startsAt: '2020-01-01T10:00:00Z',
          durationMinutes: 30,
        })
      ).statusCode,
    ).toBe(400)
    const responses = await Promise.all(
      [athlete, coach].map((actor) =>
        request(actor, 'POST', '/consultations', {
          contractId,
          title: 'Concorrência de agenda',
          startsAt: future(240),
          durationMinutes: 30,
        }),
      ),
    )
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409])
  })
  it('reagenda, registra histórico e cancela sem criar evento externo fictício', async () => {
    success(
      await request(coach, 'PATCH', `/consultations/${consultationId}`, {
        startsAt: future(120),
        reason: 'Ajustar horário por solicitação do atleta.',
      }),
    )
    const history = (
      await request(athlete, 'GET', `/consultations/${consultationId}/history`)
    ).json().history
    expect(history.map((h: { action: string }) => h.action)).toEqual([
      'created',
      'rescheduled',
    ])
    expect(
      (
        await request(athlete, 'PATCH', `/consultations/${consultationId}`, {
          status: 'completed',
          reason: 'Encontro ainda não começou.',
        })
      ).statusCode,
    ).toBe(400)
    success(
      await request(athlete, 'PATCH', `/consultations/${consultationId}`, {
        status: 'cancelled',
        reason: 'Não poderei participar deste horário.',
      }),
    )
    expect(
      (await request(coach, 'GET', '/consultations'))
        .json()
        .consultations.find((c: { id: string }) => c.id === consultationId),
    ).toMatchObject({ status: 'cancelled', externalEventId: null })
  })
  it('histórico sobrevive recriação da API e contrato encerrado recusa novas interações', async () => {
    await app.close()
    app = await buildApp({ pool, origin, logger: false })
    await app.ready()
    expect(
      (await request(coach, 'GET', `/contracts/${contractId}/messages`)).json()
        .messages.length,
    ).toBeGreaterThan(5)
    await pool.query("UPDATE contracts SET status='cancelled' WHERE id=$1", [
      contractId,
    ])
    expect(
      (
        await request(athlete, 'POST', `/contracts/${contractId}/messages`, {
          text: 'Não enviar depois do encerramento.',
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await request(coach, 'POST', '/consultations', {
          contractId,
          title: 'Vínculo encerrado',
          startsAt: future(500),
          durationMinutes: 30,
        })
      ).statusCode,
    ).toBe(403)
    success(await request(athlete, 'GET', `/contracts/${contractId}/messages`))
  })
})
