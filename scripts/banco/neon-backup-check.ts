import { pathToFileURL } from 'node:url'
import { S3Client, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { assertFreshValidation, backupKey, backupStorage, decodeValidation, required, validationKey, type BackupValidation } from './neon-backup-shared.js'
import { readObject } from './neon-backup-objects.js'

export async function checkValidatedBackup(storage: S3Client, bucket: string, key: Buffer, now = new Date()) {
  let continuation: string | undefined
  const markers: string[] = []
  do {
    const page = await storage.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'neon/validated/', ContinuationToken: continuation }))
    for (const object of page.Contents || []) {
      if (!object.Key || !/^neon\/validated\/[a-f0-9]{32}\.lav$/.test(object.Key) || !object.LastModified) continue
      markers.push(object.Key)
    }
    continuation = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuation)
  let newest: BackupValidation | undefined
  for (const marker of markers) {
    const candidate = decodeValidation(await readObject(storage, bucket, marker, 4096), key)
    if (validationKey(candidate.backupKey) !== marker) throw new Error('Marcador nao corresponde ao backup.')
    if (!newest || Date.parse(candidate.createdAt) > Date.parse(newest.createdAt)) newest = candidate
  }
  if (!newest) throw new Error('Nenhum backup com restauracao completa validada foi encontrado.')
  const result = assertFreshValidation(newest, now)
  const head = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: result.backupKey }))
  if (head.ContentLength !== result.archiveBytes || head.Metadata?.sha256 !== result.archiveSha256) throw new Error('Arquivo validado foi removido ou alterado.')
  return result
}

export async function checkNeonBackup() {
  const storage = backupStorage()
  try {
    const result = await checkValidatedBackup(storage.client, storage.bucket, backupKey(required('NEON_BACKUP_VALIDATION_KEY')))
    console.log(JSON.stringify({ healthy: true, freshnessOnly: true, createdAt: result.createdAt, validatedAt: result.validatedAt, tables: result.tables, objects: result.objects, restoreSeconds: result.elapsedSeconds, maximumAgeHours: 26 }))
    return result
  } finally {
    storage.client.destroy()
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  checkNeonBackup().catch(() => { console.error('Backup validado ausente, atrasado, alterado ou inacessivel.'); process.exitCode = 1 })
}
