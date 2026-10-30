import { createHash } from 'node:crypto'
import { migrationBaseline } from './migration-baseline.js'

export function migrationChecksum(sql: string) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
}

export function verifyMigrationChecksum(name: string, sql: string, stored: string | null) {
  const expected = stored ?? migrationBaseline[name]
  if (!expected) throw new Error(`Baseline ausente para migration aplicada: ${name}`)
  const checksum = migrationChecksum(sql)
  if (checksum !== expected) throw new Error(`Checksum divergente na migration: ${name}`)
  return checksum
}
