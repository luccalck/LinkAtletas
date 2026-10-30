import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { validationKey, encodeValidation, decodeValidation, assertFreshValidation, restoreStorageSettings, objectBackupPrefix } from '../../scripts/banco/neon-backup-shared.js'

const key = randomBytes(32)
const record = { version: 1 as const, backupKey: 'neon/2026-10-30/' + 'a'.repeat(32) + '.lan', archiveSha256: 'b'.repeat(64), archiveBytes: 1024, createdAt: '2026-10-30T06:30:00.000Z', validatedAt: '2026-10-30T06:30:10.000Z', tables: 37, objects: 1, elapsedSeconds: 10 }

describe('validacao independente do backup', () => {
  it('autentica o resultado sem expor o manifesto', () => {
    const bytes = encodeValidation(record, key)
    expect(bytes.includes(Buffer.from(record.backupKey))).toBe(false)
    expect(decodeValidation(bytes, key)).toEqual(record)
    expect(() => decodeValidation(bytes, randomBytes(32))).toThrow()
    bytes[bytes.length - 1] ^= 1
    expect(() => decodeValidation(bytes, key)).toThrow()
  })

  it('recusa validacao ausente, atrasada ou futura', () => {
    const now = new Date('2026-10-31T07:00:00.000Z')
    expect(() => assertFreshValidation(record, now)).not.toThrow()
    expect(() => assertFreshValidation(record, new Date('2026-10-31T09:00:00.000Z'))).toThrow()
    expect(() => assertFreshValidation(record, new Date('2026-10-29T06:30:00.000Z'))).toThrow()
  })

  it('mantem objetos e marcadores no prefixo exclusivo do snapshot', () => {
    expect(objectBackupPrefix(record.backupKey)).toBe('neon/2026-10-30/' + 'a'.repeat(32) + '/objects/')
    expect(validationKey(record.backupKey)).toBe('neon/validated/' + 'a'.repeat(32) + '.lav')
    expect(() => objectBackupPrefix('../privado')).toThrow()
  })

  it('recusa armazenamento remoto e bucket de aplicacao para restauracao', () => {
    expect(restoreStorageSettings('http://127.0.0.1:8333', 'linkatletas-restore-abc-test').bucket).toBe('linkatletas-restore-abc-test')
    expect(() => restoreStorageSettings('https://fly.storage.tigris.dev', 'linkatletas-restore-abc-test')).toThrow()
    expect(() => restoreStorageSettings('http://127.0.0.1:8333', 'linkatletas-producao')).toThrow()
    expect(() => restoreStorageSettings('http://localhost:8333?host=externo', 'linkatletas-restore-abc-test')).toThrow()
  })
})
