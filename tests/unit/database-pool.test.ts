import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createPool } from '../../server/db/pool.js'

describe('conexoes PostgreSQL', () => {
  it('trata falha do cliente em uso sem encerrar o processo', async () => {
    const pool = createPool('postgresql://local:local@127.0.0.1:1/local')
    const client = new EventEmitter()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      pool.emit('connect', client)
      const error = new Error('dado privado')
      expect(() => client.emit('error', error)).not.toThrow()
      expect(() => pool.emit('error', error)).not.toThrow()
      expect(log).toHaveBeenCalledOnce()
      expect(log.mock.calls.flat().join(' ')).not.toContain('dado privado')
    } finally {
      log.mockRestore()
      await pool.end()
    }
  })

  it('trata desconexoes ociosas sem encerrar o processo nem registrar dados privados', async () => {
    const pool = createPool('postgresql://local:local@127.0.0.1:1/local')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => pool.emit('error', new Error('dado privado'))).not.toThrow()
      expect(log).toHaveBeenCalledOnce()
      expect(log.mock.calls.flat().join(' ')).not.toContain('dado privado')
    } finally {
      log.mockRestore()
      await pool.end()
    }
  })

  it('define prazos finitos para consultas e transacoes ociosas', async () => {
    const pool = createPool('postgresql://local:local@127.0.0.1:1/local')
    try {
      expect(pool.options.statement_timeout).toBe(30000)
      expect(pool.options.query_timeout).toBe(35000)
      expect(pool.options.lock_timeout).toBe(5000)
      expect(pool.options.idle_in_transaction_session_timeout).toBe(60000)
    } finally {
      await pool.end()
    }
  })
})
