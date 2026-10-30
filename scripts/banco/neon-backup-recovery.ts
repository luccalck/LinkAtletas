import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { S3Client } from '@aws-sdk/client-s3'
import { decryptPrivate, encryptPrivate } from '../../server/shared/crypto.js'
import { type FullNeonArchive } from './neon-backup-shared.js'
import { readObject } from './neon-backup-objects.js'

const encryptedColumns = [
  ['private_health', 'encrypted_data'], ['executions', 'private_payload'],
  ['messages', 'body_ciphertext'], ['media_feedback', 'encrypted_text'],
  ['consultations', 'description_ciphertext'], ['mail_outbox', 'encrypted_body'],
] as const

export async function verifyPrivateData(database: pg.Client) {
  let checked = 0
  const fixture = 'recuperacao-privada-ficticia-' + randomUUID()
  if (decryptPrivate(encryptPrivate(fixture)) !== fixture) throw new Error('Chave de dados nao passou no ensaio privado.')
  for (const [table, column] of encryptedColumns) {
    const predicate = column + ' IS NOT NULL' + (table === 'mail_outbox' ? " AND NOT (sent_at IS NOT NULL AND encrypted_body='')" : '')
    let offset = 0
    while (true) {
      const rows = (await database.query(`SELECT ${column} AS value FROM public.${table} WHERE ${predicate} ORDER BY ${table === 'private_health' ? 'user_id' : 'id'} LIMIT 100 OFFSET $1`, [offset])).rows
      for (const row of rows) {
        decryptPrivate(row.value)
        checked++
      }
      if (rows.length < 100) break
      offset += rows.length
    }
  }
  return checked
}

export async function verifyPrivateObjects(database: pg.Client, storage: S3Client, bucket: string, archive: FullNeonArchive) {
  const media = (await database.query('SELECT object_key,size FROM media WHERE deleted_at IS NULL ORDER BY object_key')).rows
  if (media.length !== archive.objects.length || new Set(archive.objects.map(object => object.sourceKey)).size !== media.length) throw new Error('Manifesto de arquivos nao cobre os registros ativos.')
  const manifest = new Map(archive.objects.map(object => [object.sourceKey, object]))
  for (const row of media) {
    const object = manifest.get(row.object_key)
    if (!object) throw new Error('Arquivo ativo ausente do manifesto.')
    const encrypted = await readObject(storage, bucket, object.sourceKey)
    const plain = decryptPrivate(encrypted.toString('utf8'))
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(plain) || Buffer.from(plain, 'base64').length !== row.size) throw new Error('Arquivo privado nao corresponde ao tamanho original.')
  }
  return media.length
}

export async function verifyRestoredApplication(database: pg.Client, url: URL, archive: FullNeonArchive) {
  const role = 'linkatletas_restore_runtime_' + randomBytes(8).toString('hex')
  const password = randomBytes(32).toString('base64url')
  await database.query(`CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN PASSWORD ${pg.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
  await database.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(decodeURIComponent(url.pathname.slice(1)))} TO ${pg.escapeIdentifier(role)}`)
  await database.query(`GRANT USAGE ON SCHEMA public TO ${pg.escapeIdentifier(role)}`)
  for (const [table, privileges] of Object.entries(archive.runtimePrivileges)) {
    if (!Object.hasOwn(archive.tableCounts, table)) throw new Error('Permissao referencia tabela fora do manifesto.')
    if (privileges.length) await database.query(`GRANT ${privileges.join(',')} ON TABLE public.${pg.escapeIdentifier(table)} TO ${pg.escapeIdentifier(role)}`)
  }
  const runtimeUrl = new URL(url)
  runtimeUrl.username = role
  runtimeUrl.password = password
  Object.assign(process.env, {
    NODE_ENV: 'test', VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: '',
    DATABASE_URL: runtimeUrl.toString(), APP_ORIGIN: 'http://localhost:4173',
    BILLING_MODE: 'academic', ASAAS_API_KEY: '', ASAAS_WEBHOOK_TOKEN: '',
    S3_ENDPOINT: process.env.NEON_BACKUP_RESTORE_S3_ENDPOINT,
    S3_BUCKET: process.env.NEON_BACKUP_RESTORE_S3_BUCKET,
    S3_ACCESS_KEY: process.env.NEON_BACKUP_RESTORE_S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.NEON_BACKUP_RESTORE_S3_SECRET_KEY,
    S3_REGION: 'us-east-1', SMTP_HOST: '127.0.0.1', SMTP_PORT: '9',
    SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: 'backup@example.invalid',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_ANDROID_CLIENT_ID: '', GOOGLE_IOS_CLIENT_ID: '',
  })
  const pool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 2, connectionTimeoutMillis: 15000 })
  const email = 'restore-' + randomUUID() + '@example.invalid'
  const fixturePassword = randomBytes(24).toString('base64url')
  let app: import('fastify').FastifyInstance | undefined
  try {
    const { buildApp } = await import('../../server/app.js')
    app = await buildApp({ pool, logger: false, origin: 'http://localhost:4173', secureCookies: false, serveFrontend: false })
    const health = await app.inject({ method: 'GET', url: '/api/health' })
    if (health.statusCode !== 200 || health.json().ok !== true) throw new Error('Aplicacao restaurada nao passou no health.')
    const signup = await app.inject({ method: 'POST', url: '/api/auth/native/register', payload: { name: 'Conta ficticia de restauracao', email, password: fixturePassword, role: 'athlete' } })
    if (signup.statusCode !== 201 || !signup.json().user?.id) throw new Error('Cadastro isolado nao persistiu apos restauracao.')
    const login = await app.inject({ method: 'POST', url: '/api/auth/native/login', payload: { email, password: fixturePassword } })
    if (login.statusCode !== 200 || !login.json().token) throw new Error('Login isolado falhou apos restauracao.')
    const headers = { authorization: 'Bearer ' + login.json().token }
    const profile = await app.inject({ method: 'GET', url: '/api/profiles/me', headers })
    if (profile.statusCode !== 200 || profile.json().profile?.userId !== signup.json().user.id) throw new Error('Leitura autenticada do perfil restaurado falhou.')
    const persisted = await database.query('SELECT count(*)::int AS total FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.email=$1', [email])
    if (persisted.rows[0].total !== 1) throw new Error('Persistencia da aplicacao nao comprovada.')
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/native/register', payload: { name: 'Conta invalida', email: 'invalid', password: 'x', role: 'admin' } })
    if (blocked.statusCode !== 400) throw new Error('Validacao de entrada restaurada falhou.')
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, origin: 'http://localhost:4173' } })
    if (logout.statusCode !== 200) throw new Error('Encerramento de sessao restaurada falhou.')
    return { health: true, signup: true, login: true, profile: true, persisted: true, invalidInputRejected: true, logout: true, limitedRuntimeRole: true }
  } finally {
    await app?.close()
    await pool.end()
    await database.query('DELETE FROM users WHERE email=$1', [email])
    await database.query(`DROP OWNED BY ${pg.escapeIdentifier(role)}`)
    await database.query(`DROP ROLE ${pg.escapeIdentifier(role)}`)
  }
}
