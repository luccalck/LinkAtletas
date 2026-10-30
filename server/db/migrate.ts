import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Pool } from 'pg'
import { createPool, transaction } from './pool.js'
import { encryptPrivate } from '../shared/crypto.js'
import { migrationChecksum, verifyMigrationChecksum } from './migration-checksum.js'
import { configureApplicationRuntimePrivileges } from './runtime-privileges.js'

export async function migrate(pool: Pool, options: { directory?: string } = {}) {
  const directory = options.directory ?? fileURLToPath(new URL('./migrations/', import.meta.url))
  const sources = new Map<string, string>()
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    sources.set(name, await readFile(path.join(directory, name), 'utf8'))
  }
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(128712026)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, checksum TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT')
    const applied = await client.query<{ version: string; checksum: string | null }>('SELECT version,checksum FROM schema_migrations ORDER BY version')
    const appliedNames = new Set(applied.rows.map((row) => row.version))
    for (const row of applied.rows) {
      const source = sources.get(row.version)
      if (source === undefined) throw new Error(`Arquivo de migration aplicada ausente: ${row.version}`)
      const checksum = verifyMigrationChecksum(row.version, source, row.checksum)
      if (row.checksum === null) await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [checksum, row.version])
    }
    for (const [name, source] of sources) {
      if (appliedNames.has(name)) continue
      await client.query(source)
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [name, migrationChecksum(source)])
    }
    await client.query('ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL')
    const existing = await client.query(
      "SELECT id,notes,metrics FROM executions WHERE private_payload IS NULL AND (notes<>'' OR metrics<>'{}'::jsonb) FOR UPDATE",
    )
    for (const row of existing.rows)
      await client.query(
        "UPDATE executions SET private_payload=$1,notes='',metrics='{}' WHERE id=$2",
        [
          encryptPrivate(
            JSON.stringify({ notes: row.notes, metrics: row.metrics }),
          ),
          row.id,
        ],
      )
    await configureApplicationRuntimePrivileges(client)
  })
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pool = createPool()
  try {
    await migrate(pool)
    console.log('Migrations aplicadas.')
  } finally {
    await pool.end()
  }
}
