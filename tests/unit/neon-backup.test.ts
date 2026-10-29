import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { backupKey, decodeBackup, encodeBackup, expiredBackups, postgresFailure, restoreDatabase, sourceDatabase } from '../../scripts/banco/neon-backup-shared.js'

const archive = {
  version: 1 as const,
  createdAt: '2026-10-29T06:30:00.000Z',
  tableCounts: { users: 2 },
  migrations: ['001_initial.sql'],
  dataKeyFingerprint: 'a'.repeat(64),
  dumpBase64: Buffer.from('PGDMPconteudo privado').toString('base64'),
}

describe('backup cifrado do Neon', () => {
  it('classifica erros sem publicar stderr ou dados privados', () => {
    expect(postgresFailure('ERROR: schema "public" already exists')).toContain('[PUBLIC_SCHEMA_EXISTS]')
    expect(postgresFailure('ERROR: function public.gen_random_uuid() does not exist')).toContain('[FUNCTION_MISSING]')
    expect(postgresFailure('DETAIL: chave e dado privado')).toBe('Comando PostgreSQL falhou [COMMAND_FAILED].')
  })
  it('cifra e autentica o dump e seu manifesto com nonce exclusivo', () => {
    const key = randomBytes(32)
    const first = encodeBackup(archive, key)
    const second = encodeBackup(archive, key)
    expect(first.equals(second)).toBe(false)
    expect(first.includes(Buffer.from('conteudo privado'))).toBe(false)
    expect(decodeBackup(first, key)).toEqual(archive)
  })

  it('recusa chave incorreta, adulteracao e arquivo truncado', () => {
    const key = randomBytes(32)
    const sealed = encodeBackup(archive, key)
    expect(() => decodeBackup(sealed, randomBytes(32))).toThrow()
    const altered = Buffer.from(sealed)
    altered[altered.length - 1] ^= 1
    expect(() => decodeBackup(altered, key)).toThrow()
    expect(() => decodeBackup(sealed.subarray(0, 25), key)).toThrow()
  })

  it.each(['', 'abc', randomBytes(31).toString('base64')])('recusa chave invalida: %s', (value) => {
    expect(() => backupKey(value)).toThrow()
  })

  it('seleciona somente backups do formato proprio com mais de sete dias', () => {
    const old = 'neon/2026-10-01/' + 'a'.repeat(32) + '.lan'
    const recent = 'neon/2026-10-28/' + 'b'.repeat(32) + '.lan'
    expect(expiredBackups([
      { Key: old, LastModified: new Date('2026-10-01') },
      { Key: recent, LastModified: new Date('2026-10-28') },
      { Key: 'arquivos/privado.pdf', LastModified: new Date('2026-10-01') },
      { Key: 'neon/2026-10-01/../arquivo.lan', LastModified: new Date('2026-10-01') },
      { Key: recent },
    ], new Date('2026-10-29'))).toEqual([old])
  })

  it('exige conexao direta Neon e preserva a senha sem inserir em argumentos', () => {
    const url = sourceDatabase('postgresql://reader:senha@ep-demo-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require')
    expect(url.hostname).toBe('ep-demo.sa-east-1.aws.neon.tech')
    expect(url.searchParams.get('sslmode')).toBe('verify-full')
    expect(url.password).toBe('senha')
    expect(() => sourceDatabase('postgresql://reader:senha@outro.example/neondb')).toThrow()
  })

  it('permite restauracao somente em localhost e banco com sufixo de teste', () => {
    expect(restoreDatabase('postgresql://teste:teste@127.0.0.1:54338/restauracao_test').pathname).toBe('/restauracao_test')
    expect(() => restoreDatabase('postgresql://teste:teste@localhost/producao')).toThrow()
    expect(() => restoreDatabase('postgresql://teste:teste@ep-demo.neon.tech/restauracao_test')).toThrow()
  })
})
