import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { backupKey, backupStorage, decodeBackup, encodeBackup, expiredBackups, postgresCommand, required, sourceDatabase } from './neon-backup-shared.js'

export async function createNeonBackup() {
  const url = sourceDatabase(required('NEON_BACKUP_DATABASE_URL'))
  const key = backupKey(required('NEON_BACKUP_ENCRYPTION_KEY'))
  const fingerprint = required('NEON_BACKUP_DATA_KEY_FINGERPRINT')
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Fingerprint da chave de dados invalido.')
  const database = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000 })
  database.on('error', () => {})
  const { client: storage, bucket, endpoint } = backupStorage()
  let connected = false
  try {
    await database.connect()
    connected = true
    const rights = await database.query(`SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS elevated FROM pg_roles WHERE rolname=current_user`)
    const writes = await database.query(`SELECT count(*)::int AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') OR pg_get_userbyid(c.relowner)=current_user)`)
    const ddl = await database.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') OR has_schema_privilege(current_user,'public','CREATE') AS allowed")
    if (rights.rows[0].elevated || writes.rows[0].total || ddl.rows[0].allowed) throw new Error('Backup exige conta somente leitura.')
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await database.query("SET LOCAL statement_timeout='2min'")
    await database.query("SET LOCAL idle_in_transaction_session_timeout='5min'")
    const tables = (await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
    if (!tables.length) throw new Error('Origem vazia; backup cancelado.')
    const counts: Record<string, number> = {}
    for (const table of tables) {
      counts[table.tablename] = Number((await database.query(`SELECT count(*) AS total FROM public.${pg.escapeIdentifier(table.tablename)}`)).rows[0].total)
    }
    const migrations = (await database.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version as string)
    const snapshot = (await database.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot as string
    if (!/^[0-9A-Fa-f-]+$/.test(snapshot)) throw new Error('Snapshot invalido.')
    const dump = await postgresCommand('pg_dump', url, ['--format=custom', '--schema=public', '--no-owner', '--no-privileges', '--no-comments', '--lock-wait-timeout=5s', '--snapshot=' + snapshot])
    await database.query('ROLLBACK')
    const createdAt = new Date().toISOString()
    const bytes = encodeBackup({ version: 1, createdAt, tableCounts: counts, migrations, dataKeyFingerprint: fingerprint, dumpBase64: dump.toString('base64') }, key)
    const objectKey = `neon/${createdAt.slice(0, 10)}/${randomUUID().replaceAll('-', '')}.lan`
    await storage.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: 'application/octet-stream', CacheControl: 'private, no-store' }))
    const saved = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }))
    const checked = decodeBackup(Buffer.from(await saved.Body!.transformToByteArray()), key)
    if (checked.dumpBase64 !== dump.toString('base64')) throw new Error('Conferencia do upload falhou.')
    const anonymous = await fetch(new URL(`${bucket}/${objectKey}`, endpoint.toString().replace(/\/?$/, '/')), { method: 'HEAD', signal: AbortSignal.timeout(15000) })
    if (![401, 403, 404].includes(anonymous.status)) throw new Error('Privacidade do bucket nao comprovada.')
    let continuation: string | undefined
    let removed = 0
    do {
      const page = await storage.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'neon/', ContinuationToken: continuation }))
      for (const expired of expiredBackups(page.Contents || [])) {
        await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: expired }))
        removed++
      }
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (continuation)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `backup_key=${objectKey}\n`)
    console.log(JSON.stringify({ backupKey: objectKey, encrypted: true, private: true, tables: tables.length, bytes: bytes.length, expiredRemoved: removed }))
    return objectKey
  } finally {
    if (connected) await database.end()
    storage.destroy()
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createNeonBackup().catch(() => { console.error('Backup Neon falhou; conferir configuracao e execucao.'); process.exitCode = 1 })
}
