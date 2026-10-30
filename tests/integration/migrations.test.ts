import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrationBaseline } from '../../server/db/migration-baseline.js'
import { migrationChecksum, verifyMigrationChecksum } from '../../server/db/migration-checksum.js'
import { migrate } from '../../server/db/migrate.js'
import { createPool, transaction } from '../../server/db/pool.js'

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://linkatletas:linkatletas_dev@127.0.0.1:54329/linkatletas_test'
if (!decodeURIComponent(new URL(url).pathname).endsWith('_test')) throw new Error('Migrations exigem banco isolado com sufixo _test.')

const sourceDirectory = fileURLToPath(new URL('../../server/db/migrations/', import.meta.url))
const probeTable = `migration_test_${randomUUID().replaceAll('-', '')}`
let pool: Pool
let directory: string | undefined
let pendingVersion: string
let legacyVersion: string
let pendingSql: string
let probeId: string
let original: { version: string; checksum: string; applied_at: string }[] = []

beforeAll(async () => {
  pool = createPool(url)
  await migrate(pool)
  original = (await pool.query('SELECT version,checksum,applied_at::text FROM schema_migrations ORDER BY version')).rows
  await pool.query(`CREATE TABLE public.${probeTable}(id UUID PRIMARY KEY)`)
})

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'linkatletas-migrations-'))
  for (const name of (await readdir(sourceDirectory)).filter((name) => name.endsWith('.sql'))) {
    await writeFile(path.join(directory, name), await readFile(path.join(sourceDirectory, name)))
  }
  probeId = randomUUID()
  pendingVersion = `999_probe_${probeId}.sql`
  legacyVersion = `998_legacy_${probeId}.sql`
  pendingSql = `INSERT INTO public.${probeTable}(id) VALUES('${probeId}');`
  await writeFile(path.join(directory, pendingVersion), pendingSql)
})

afterEach(async () => {
  try {
    if (pool && original.length) {
      await transaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(128712026)')
        await client.query('ALTER TABLE schema_migrations ALTER COLUMN checksum DROP NOT NULL')
        await client.query('DELETE FROM schema_migrations WHERE version=ANY($1::text[])', [[pendingVersion, legacyVersion]])
        for (const row of original) {
          await client.query('UPDATE schema_migrations SET checksum=$1,applied_at=$2 WHERE version=$3', [row.checksum, row.applied_at, row.version])
        }
        await client.query('ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL')
        await client.query(`DELETE FROM public.${probeTable} WHERE id=$1`, [probeId])
      })
    }
  } finally {
    if (directory) {
      const location = path.resolve(directory)
      if (path.dirname(location) !== path.resolve(tmpdir()) || !path.basename(location).startsWith('linkatletas-migrations-')) {
        throw new Error('Diretorio temporario fora da area de teste.')
      }
      await rm(location, { recursive: true, force: true })
    }
    directory = undefined
  }
})

afterAll(async () => {
  try {
    if (pool && original.length) {
      const restored = (await pool.query('SELECT version,checksum,applied_at::text FROM schema_migrations ORDER BY version')).rows
      expect(restored).toEqual(original)
      await pool.query(`DROP TABLE public.${probeTable}`)
    }
  } finally {
    await pool?.end()
  }
})

function migrateCopy() {
  if (!directory) throw new Error('Diretorio de teste indisponivel.')
  return migrate(pool, { directory })
}

async function legacyChecksum() {
  await pool.query('ALTER TABLE schema_migrations ALTER COLUMN checksum DROP NOT NULL')
  await pool.query("UPDATE schema_migrations SET checksum=NULL WHERE version='001_initial.sql'")
}

async function expectPendingUntouched() {
  expect((await pool.query(`SELECT id FROM public.${probeTable} WHERE id=$1`, [probeId])).rows).toEqual([])
  expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [pendingVersion])).rows).toEqual([])
}

describe('checksums canonicos e baseline confiavel', () => {
  it('normaliza CRLF para LF preservando qualquer outra alteracao no SQL', () => {
    const source = 'SELECT 1;\nSELECT 2;\n'
    expect(migrationChecksum(source.replaceAll('\n', '\r\n'))).toBe(migrationChecksum(source))
    expect(migrationChecksum(`${source} `)).not.toBe(migrationChecksum(source))
  })

  it('confere os sete arquivos historicos contra os hashes aprovados', async () => {
    expect(Object.keys(migrationBaseline)).toEqual(['001_initial.sql', '002_platform.sql', '003_interactions.sql', '004_billing.sql', '005_billing_compatibility.sql', '006_media_uploads.sql', '007_database_integrity.sql'])
    for (const [name, checksum] of Object.entries(migrationBaseline)) {
      const source = await readFile(path.join(sourceDirectory, name), 'utf8')
      expect(verifyMigrationChecksum(name, source, null)).toBe(checksum)
    }
  })

  it('aceita checksum persistido para migration nova sem baseline historico', () => {
    const source = 'SELECT 1;'
    const checksum = migrationChecksum(source)
    expect(verifyMigrationChecksum('999_new.sql', source, checksum)).toBe(checksum)
  })

  it('recusa checksum persistido divergente', () => {
    expect(() => verifyMigrationChecksum('999_new.sql', 'SELECT 1;', '0'.repeat(64))).toThrow('Checksum divergente')
  })

  it('recusa migration legada desconhecida sem checksum', () => {
    expect(() => verifyMigrationChecksum('999_unknown.sql', 'SELECT 1;', null)).toThrow('Baseline ausente')
  })
})

describe('aplicacao atomica e verificacao previa de migrations', () => {
  it('completa checksum legado confiavel sem alterar a data de aplicacao', async () => {
    const previous = original.find((row) => row.version === '001_initial.sql')!
    await legacyChecksum()
    await migrateCopy()
    expect((await pool.query("SELECT version,checksum,applied_at::text FROM schema_migrations WHERE version='001_initial.sql'")).rows[0]).toEqual(previous)
    expect((await pool.query('SELECT checksum FROM schema_migrations WHERE version=$1', [pendingVersion])).rows[0]).toEqual({ checksum: migrationChecksum(pendingSql) })
    expect((await pool.query(`SELECT id FROM public.${probeTable} WHERE id=$1`, [probeId])).rows).toEqual([{ id: probeId }])
    expect((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='checksum'")).rows[0]).toEqual({ is_nullable: 'NO' })
  })

  it('aborta antes da migration pendente quando checksum armazenado diverge', async () => {
    await pool.query("UPDATE schema_migrations SET checksum=$1 WHERE version='001_initial.sql'", ['0'.repeat(64)])
    await expect(migrateCopy()).rejects.toThrow('Checksum divergente na migration: 001_initial.sql')
    await expectPendingUntouched()
  })

  it('aborta antes da migration pendente quando arquivo aplicado foi alterado', async () => {
    await writeFile(path.join(directory!, '001_initial.sql'), `${await readFile(path.join(directory!, '001_initial.sql'), 'utf8')}\nSELECT 1;`)
    await expect(migrateCopy()).rejects.toThrow('Checksum divergente na migration: 001_initial.sql')
    await expectPendingUntouched()
  })

  it('aceita arquivos aplicados com CRLF mantendo os mesmos checksums', async () => {
    const file = path.join(directory!, '001_initial.sql')
    await writeFile(file, (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'))
    await migrateCopy()
    expect((await pool.query('SELECT checksum FROM schema_migrations WHERE version=$1', [pendingVersion])).rows[0]).toEqual({ checksum: migrationChecksum(pendingSql) })
  })

  it('aborta se arquivo de migration aplicada estiver ausente', async () => {
    await rm(path.join(directory!, '001_initial.sql'))
    await expect(migrateCopy()).rejects.toThrow('Arquivo de migration aplicada ausente: 001_initial.sql')
    await expectPendingUntouched()
  })

  it('aborta se migration legada sem checksum nao tiver baseline aprovado', async () => {
    await pool.query('ALTER TABLE schema_migrations ALTER COLUMN checksum DROP NOT NULL')
    await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,NULL)', [legacyVersion])
    await writeFile(path.join(directory!, legacyVersion), 'SELECT 1;')
    await expect(migrateCopy()).rejects.toThrow(`Baseline ausente para migration aplicada: ${legacyVersion}`)
    await expectPendingUntouched()
  })

  it('desfaz backfill anterior quando outra migration aplicada diverge', async () => {
    await legacyChecksum()
    const next = original.find((row) => row.version !== '001_initial.sql')!.version
    await writeFile(path.join(directory!, next), `${await readFile(path.join(directory!, next), 'utf8')}\nSELECT 1;`)
    await expect(migrateCopy()).rejects.toThrow(`Checksum divergente na migration: ${next}`)
    expect((await pool.query("SELECT checksum FROM schema_migrations WHERE version='001_initial.sql'")).rows[0]).toEqual({ checksum: null })
    await expectPendingUntouched()
  })

  it('desfaz SQL e registro de migration se a execucao falhar', async () => {
    await writeFile(path.join(directory!, pendingVersion), `${pendingSql}\nSELECT 1/0;`)
    await expect(migrateCopy()).rejects.toMatchObject({ code: '22012' })
    await expectPendingUntouched()
  })

  it('serializa migradores concorrentes e aplica a migration uma unica vez', async () => {
    await Promise.all([migrateCopy(), migrateCopy()])
    expect((await pool.query(`SELECT id FROM public.${probeTable} WHERE id=$1`, [probeId])).rows).toEqual([{ id: probeId }])
    expect((await pool.query('SELECT version,checksum FROM schema_migrations WHERE version=$1', [pendingVersion])).rows).toEqual([{ version: pendingVersion, checksum: migrationChecksum(pendingSql) }])
    await migrateCopy()
    expect((await pool.query(`SELECT count(*)::int AS total FROM public.${probeTable} WHERE id=$1`, [probeId])).rows[0]).toEqual({ total: 1 })
  })
})
