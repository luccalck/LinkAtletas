import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../server/app.js'

describe('limitacao de tentativas de autenticacao', () => {
  it('bloqueia excesso com 429, preserva isolamento por IP e nao limita a consulta de sessao', async () => {
    const query = vi.fn()
    const pool = { query } as unknown as Pool
    const app = await buildApp({ pool, origin: 'http://localhost:5173' })
    const attempt = (remoteAddress: string) => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:5173' },
      payload: {},
      remoteAddress,
    })
    try {
      for (let i = 0; i < 20; i++) {
        expect((await attempt('192.0.2.1')).statusCode).toBe(400)
      }
      const blocked = await attempt('192.0.2.1')
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json()).toMatchObject({ code: 'RATE_LIMIT' })
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
      expect((await attempt('192.0.2.2')).statusCode).toBe(400)
      const session = await app.inject({ url: '/api/auth/session', remoteAddress: '192.0.2.1' })
      expect(session.statusCode).toBe(200)
      expect(session.json()).toEqual({ user: null })
      expect(query).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('agrupa enderecos IPv6 da mesma subrede sem bloquear outra subrede', async () => {
    const app = await buildApp({ pool: { query: vi.fn() } as unknown as Pool })
    const attempt = (remoteAddress: string) => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:5173' },
      payload: {},
      remoteAddress,
    })
    try {
      for (let i = 1; i <= 20; i++) {
        expect((await attempt(`2001:db8:1::${i}`)).statusCode).toBe(400)
      }
      expect((await attempt('2001:db8:1::99')).statusCode).toBe(429)
      expect((await attempt('2001:db8:2::1')).statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
