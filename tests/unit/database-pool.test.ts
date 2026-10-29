import { describe, expect, it, vi } from 'vitest'
import { createPool } from '../../server/db/pool.js'

describe('conexoes PostgreSQL', () => {
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
