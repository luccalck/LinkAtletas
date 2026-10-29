import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { backupKey, backupPattern, backupStorage, decodeBackup, MAX_BACKUP_BYTES, postgresCommand, required, restoreDatabase } from './neon-backup-shared.js'

export async function verifyNeonBackup(objectKey: string) {
  if (!backupPattern.test(objectKey)) throw new Error('Objeto de backup invalido.')
  const url = restoreDatabase(required('NEON_BACKUP_RESTORE_URL'))
  const key = backupKey(required('NEON_BACKUP_ENCRYPTION_KEY'))
  const { client: storage, bucket } = backupStorage()
  const database = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000 })
  database.on('error', () => {})
  let connected = false
  try {
    const response = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }))
    if (!response.ContentLength || response.ContentLength > MAX_BACKUP_BYTES) throw new Error('Tamanho de backup invalido.')
    const archive = decodeBackup(Buffer.from(await response.Body!.transformToByteArray()), key)
    if (archive.dataKeyFingerprint !== required('NEON_BACKUP_DATA_KEY_FINGERPRINT')) throw new Error('Chave de dados original nao corresponde ao manifesto.')
    await database.connect()
    connected = true
    const existing = await database.query("SELECT count(*)::int AS total FROM pg_tables WHERE schemaname='public'")
    if (existing.rows[0].total) throw new Error('Restauracao exige destino vazio; nenhum dado foi removido.')
    await postgresCommand('pg_restore', url, ['--dbname', decodeURIComponent(url.pathname.slice(1)), '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction'], Buffer.from(archive.dumpBase64, 'base64'))
    const tables = (await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename as string)
    if (JSON.stringify(tables) !== JSON.stringify(Object.keys(archive.tableCounts).sort())) throw new Error('Tabelas restauradas divergem do manifesto.')
    for (const table of tables) {
      const total = Number((await database.query(`SELECT count(*) AS total FROM public.${pg.escapeIdentifier(table)}`)).rows[0].total)
      if (total !== archive.tableCounts[table]) throw new Error('Contagem restaurada diverge do snapshot.')
    }
    const migrations = (await database.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version as string)
    if (JSON.stringify(migrations) !== JSON.stringify(archive.migrations)) throw new Error('Migrations restauradas divergem do manifesto.')
    const invalid = await database.query("SELECT count(*)::int AS total FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT convalidated")
    if (invalid.rows[0].total) throw new Error('Restricoes restauradas nao validadas.')
    console.log(JSON.stringify({ restored: true, isolated: true, tables: tables.length, migrations: migrations.length, snapshotCountsMatch: true }))
  } finally {
    if (connected) await database.end()
    storage.destroy()
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyNeonBackup(process.argv[2] || '').catch(() => { console.error('Verificacao de restauracao Neon falhou.'); process.exitCode = 1 })
}
