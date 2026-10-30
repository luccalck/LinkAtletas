import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyPrivateData } from '../../scripts/banco/neon-backup-recovery.js'
import { decryptPrivate, encryptPrivate } from '../../server/shared/crypto.js'
import { decodeBackup, decodeValidation, encodeBackup, encodeValidation, type FullNeonArchive } from '../../scripts/banco/neon-backup-shared.js'
import { verifyNeonBackup } from '../../scripts/banco/neon-restore-test.js'

const archive: FullNeonArchive = {
  version: 2,
  createdAt: '2026-10-30T06:30:00.000Z',
  tableCounts: { users: 2, media: 1 },
  migrations: ['001_initial.sql'],
  migrationChecksums: { '001_initial.sql': 'e'.repeat(64) },
  dataKeyFingerprint: 'a'.repeat(64),
  dumpBase64: Buffer.from('PGDMPfixture').toString('base64'),
  extensions: [{ name: 'pgcrypto', version: '1.4' }],
  runtimePrivileges: { users: ['SELECT', 'INSERT', 'UPDATE'], media: ['SELECT'] },
  objects: [{ sourceKey: 'private/fixture', backupKey: 'neon/2026-10-30/' + 'b'.repeat(32) + '/objects/' + 'c'.repeat(64), bytes: 20, sha256: 'd'.repeat(64) }],
}

afterEach(() => vi.unstubAllEnvs())

describe('manifesto completo e restauracao privada', () => {
  it('preserva objetos, extensoes, checksums e permissoes sem credenciais', () => {
    const key = randomBytes(32)
    const bytes = encodeBackup(archive, key)
    expect(decodeBackup(bytes, key)).toEqual(archive)
    expect(bytes.includes(Buffer.from('private/fixture'))).toBe(false)
    expect(bytes.includes(Buffer.from('001_initial.sql'))).toBe(false)
  })

  it('recusa manifesto v2 sem lista de objetos ou checksum valido', () => {
    const key = randomBytes(32)
    expect(() => encodeBackup({ ...archive, objects: undefined } as unknown as FullNeonArchive, key)).toThrow()
    expect(() => encodeBackup({ ...archive, migrationChecksums: { '001_initial.sql': 'invalido' } }, key)).toThrow()
  })

  it('separa dominio criptografico do arquivo e do marcador de recuperacao', () => {
    const key = randomBytes(32)
    const marker = encodeValidation({ version: 1, backupKey: 'neon/2026-10-30/' + 'b'.repeat(32) + '.lan', archiveSha256: 'a'.repeat(64), archiveBytes: 100, createdAt: archive.createdAt, validatedAt: archive.createdAt, tables: 2, objects: 1, elapsedSeconds: 0 }, key)
    expect(() => decodeBackup(marker, key)).toThrow()
    expect(() => decodeValidation(encodeBackup(archive, key), key)).toThrow()
  })

  it('descriptografa todas as colunas privadas em memoria sem imprimir conteudo', async () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
    const value = encryptPrivate('dado ficticio')
    const query = vi.fn(async () => ({ rows: [{ value }] }))
    const count = await verifyPrivateData({ query } as unknown as pg.Client)
    expect(count).toBe(6)
    expect(query).toHaveBeenCalledTimes(6)
    expect(decryptPrivate(value)).toBe('dado ficticio')
  })

  it('falha na presenca de envelope privado adulterado', async () => {
    vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
    const query = vi.fn(async () => ({ rows: [{ value: 'la1:invalido' }] }))
    await expect(verifyPrivateData({ query } as unknown as pg.Client)).rejects.toThrow()
  })

  it('recusa chave do monitor igual a chave do dump ou dos dados antes de qualquer acesso', async () => {
    const dumpKey = randomBytes(32).toString('base64')
    const dataKey = randomBytes(32).toString('base64')
    vi.stubEnv('NEON_BACKUP_RESTORE_URL', 'postgresql://restore:local@127.0.0.1:54338/linkatletas_restore_test')
    vi.stubEnv('NEON_BACKUP_ENCRYPTION_KEY', dumpKey)
    vi.stubEnv('NEON_BACKUP_DATA_ENCRYPTION_KEY', dataKey)
    vi.stubEnv('NEON_BACKUP_VALIDATION_KEY', dumpKey)
    const objectKey = 'neon/2026-10-30/' + 'b'.repeat(32) + '.lan'
    await expect(verifyNeonBackup(objectKey)).rejects.toThrow('Chave de validacao deve ser independente')
    vi.stubEnv('NEON_BACKUP_VALIDATION_KEY', dataKey)
    await expect(verifyNeonBackup(objectKey)).rejects.toThrow('Chave de validacao deve ser independente')
  })
})
