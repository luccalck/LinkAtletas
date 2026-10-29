import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024
export const backupPattern = /^neon\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{32}\.lan$/
const header = Buffer.from('LAN1')
const archiveSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  tableCounts: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), z.number().int().nonnegative()),
  migrations: z.array(z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/)),
  dataKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  dumpBase64: z.string().min(8),
}).strict()
export type NeonArchive = z.infer<typeof archiveSchema>

export function backupKey(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Chave de backup invalida.')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('Chave de backup invalida.')
  return key
}

export function encodeBackup(input: NeonArchive, key: Buffer) {
  const value = archiveSchema.parse(input)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(header)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  const output = Buffer.concat([header, iv, cipher.getAuthTag(), encrypted])
  if (output.length > MAX_BACKUP_BYTES) throw new Error('Backup ultrapassa o limite de memoria configurado.')
  return output
}

export function decodeBackup(bytes: Buffer, key: Buffer): NeonArchive {
  if (bytes.length < 33 || bytes.length > MAX_BACKUP_BYTES || !bytes.subarray(0, 4).equals(header)) {
    throw new Error('Arquivo de backup invalido.')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16))
  decipher.setAAD(header)
  decipher.setAuthTag(bytes.subarray(16, 32))
  const value = Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()])
  const archive = archiveSchema.parse(JSON.parse(value.toString('utf8')))
  if (Buffer.from(archive.dumpBase64, 'base64').subarray(0, 5).toString() !== 'PGDMP') {
    throw new Error('Dump PostgreSQL invalido.')
  }
  return archive
}

export function expiredBackups(objects: { Key?: string; LastModified?: Date }[], now = new Date()) {
  return objects.filter(object => object.Key && backupPattern.test(object.Key) && object.LastModified &&
    object.LastModified.getTime() < now.getTime() - 7 * 86400000).map(object => object.Key!)
}

export function sourceDatabase(value: string) {
  const url = new URL(value)
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech') || !url.username || !url.password) {
    throw new Error('Origem exige conexao Neon autenticada.')
  }
  const labels = url.hostname.split('.')
  labels[0] = labels[0].replace(/-pooler$/, '')
  url.hostname = labels.join('.')
  url.searchParams.set('sslmode', 'verify-full')
  return url
}

export function restoreDatabase(value: string) {
  const url = new URL(value)
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !decodeURIComponent(url.pathname.slice(1)).endsWith('_test')) throw new Error('Restauracao exige base local isolada com sufixo _test.')
  url.searchParams.set('sslmode', 'disable')
  return url
}

export function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error('Configuracao de backup ausente: ' + name)
  return value
}

export function backupStorage() {
  const endpoint = new URL(required('NEON_BACKUP_S3_ENDPOINT'))
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.tigris.dev')) throw new Error('Endpoint Tigris invalido.')
  const bucket = required('NEON_BACKUP_BUCKET')
  if (!/^linkatletas-backups-[a-z0-9-]+$/.test(bucket)) throw new Error('Bucket exclusivo de backup obrigatorio.')
  const client = new S3Client({
    endpoint: endpoint.toString(), region: 'auto', forcePathStyle: true,
    credentials: { accessKeyId: required('NEON_BACKUP_ACCESS_KEY'), secretAccessKey: required('NEON_BACKUP_SECRET_KEY') },
    requestHandler: { connectionTimeout: 15000, requestTimeout: 120000 },
  })
  return { client, bucket, endpoint }
}

export async function postgresCommand(tool: 'pg_dump' | 'pg_restore', url: URL, args: string[], input?: Buffer) {
  const variables = {
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') || 'verify-full', PGCONNECT_TIMEOUT: '15',
    PGSSLROOTCERT: url.searchParams.get('sslmode') === 'disable' ? undefined : 'system',
  }
  const child = spawn('docker', [
    'run', '--rm', '--network', 'host', '-i',
    ...Object.keys(variables).flatMap(name => ['--env', name]),
    'postgres:18-alpine', tool, ...args,
  ], { env: { ...process.env, ...variables }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  const output: Buffer[] = []
  let size = 0
  const finished = new Promise<Buffer>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BACKUP_BYTES) { child.kill(); reject(new Error('Dump excede o limite de memoria.')); return }
      output.push(chunk)
    })
    child.once('error', () => reject(new Error('Cliente PostgreSQL indisponivel.')))
    child.once('close', code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error('Comando PostgreSQL falhou.')))
  })
  const timeout = setTimeout(() => child.kill(), 180000)
  try {
    child.stdin.end(input)
    return await finished
  } finally { clearTimeout(timeout) }
}
