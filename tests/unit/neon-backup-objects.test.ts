import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { copyEncryptedObject, readObject } from '../../scripts/banco/neon-backup-objects.js'
import { checkValidatedBackup } from '../../scripts/banco/neon-backup-check.js'
import { encodeValidation, validationKey } from '../../scripts/banco/neon-backup-shared.js'

const secret = Buffer.alloc(32, 17)
const record = { version: 1 as const, backupKey: 'neon/2026-10-30/' + 'c'.repeat(32) + '.lan', archiveSha256: 'd'.repeat(64), archiveBytes: 1024, createdAt: '2026-10-30T06:30:00.000Z', validatedAt: '2026-10-30T06:30:10.000Z', tables: 37, objects: 1, elapsedSeconds: 10 }
const now = new Date('2026-10-30T08:00:00.000Z')

function source(bytes: Buffer) {
  return { send: vi.fn(async () => ({ ContentLength: bytes.length, Body: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]) })) } as unknown as S3Client
}

function target(corrupt = false) {
  let stored = Buffer.alloc(0)
  const send = vi.fn(async (command: GetObjectCommand | PutObjectCommand) => {
    if (command instanceof PutObjectCommand) {
      const chunks: Buffer[] = []
      for await (const chunk of command.input.Body as Readable) chunks.push(Buffer.from(chunk))
      stored = Buffer.concat(chunks)
      return {}
    }
    if (command instanceof GetObjectCommand) {
      const bytes = Buffer.from(stored)
      if (corrupt) bytes[bytes.length - 1] ^= 1
      return { ContentLength: bytes.length, Body: Readable.from([bytes]) }
    }
    throw new Error('Comando inesperado no teste.')
  })
  return { client: { send } as unknown as S3Client, send, read: () => stored }
}

describe('copia independente de objetos e monitor', () => {
  it('copia fluxo cifrado em partes e confere hash por releitura', async () => {
    const bytes = Buffer.from('la1:envelope-ficticio')
    const destination = target()
    const result = await copyEncryptedObject(source(bytes), 'source', 'private/id', destination.client, 'backups', 'snapshot/obj')
    expect(result).toEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(destination.read()).toEqual(bytes)
    expect(destination.send).toHaveBeenCalledTimes(2)
  })

  it('rejeita alteracao na copia independente', async () => {
    const destination = target(true)
    await expect(copyEncryptedObject(source(Buffer.from('la1:cifrado')), 'source', 'key', destination.client, 'backup', 'key')).rejects.toThrow()
  })

  it('nao transmite conteudo sem envelope privado', async () => {
    const destination = target()
    await expect(copyEncryptedObject(source(Buffer.from('texto privado')), 'source', 'key', destination.client, 'backup', 'key')).rejects.toThrow()
    expect(destination.read().length).toBe(0)
  })

  it('cancela o request S3 quando a origem falha antes de enviar bytes', async () => {
    let aborted = false
    const send = vi.fn((_command: PutObjectCommand, options: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
      const cancel = () => { aborted = true; reject(new Error('Upload cancelado.')) }
      if (options.abortSignal.aborted) cancel()
      else options.abortSignal.addEventListener('abort', cancel, { once: true })
    }))
    await expect(copyEncryptedObject(source(Buffer.from('texto privado')), 'source', 'key', { send } as unknown as S3Client, 'backup', 'key')).rejects.toThrow('Copia cifrada ou conferencia de objeto falhou.')
    expect(aborted).toBe(true)
  })

  it('limita leitura quando o tamanho informado nao corresponde ao fluxo', async () => {
    const client = { send: vi.fn(async () => ({ ContentLength: 4, Body: Readable.from([Buffer.alloc(20)]) })) } as unknown as S3Client
    await expect(readObject(client, 'bucket', 'key', 8)).rejects.toThrow()
  })

  it('nao confunde arquivos apenas enviados com backups restaurados', async () => {
    const send = vi.fn(async () => ({ Contents: [{ Key: record.backupKey, LastModified: now }] }))
    await expect(checkValidatedBackup({ send } as unknown as S3Client, 'bucket', secret, now)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('consulta apenas objetos e metadados sem escrever nem acessar banco', async () => {
    const marker = encodeValidation(record, secret)
    const send = vi.fn(async (command: GetObjectCommand | HeadObjectCommand | ListObjectsV2Command) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: validationKey(record.backupKey), LastModified: now }] }
      if (command instanceof GetObjectCommand) return { ContentLength: marker.length, Body: Readable.from([marker]) }
      if (command instanceof HeadObjectCommand) return { ContentLength: record.archiveBytes, Metadata: { sha256: record.archiveSha256 } }
      throw new Error('Mutacao nao permitida.')
    })
    const result = await checkValidatedBackup({ send } as unknown as S3Client, 'bucket', secret, now)
    expect(result).toEqual(record)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('detecta arquivo validado removido ou substituido', async () => {
    const marker = encodeValidation(record, secret)
    const send = vi.fn(async (command: GetObjectCommand | HeadObjectCommand | ListObjectsV2Command) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: validationKey(record.backupKey), LastModified: now }] }
      if (command instanceof GetObjectCommand) return { ContentLength: marker.length, Body: Readable.from([marker]) }
      return { ContentLength: record.archiveBytes, Metadata: { sha256: 'f'.repeat(64) } }
    })
    await expect(checkValidatedBackup({ send } as unknown as S3Client, 'bucket', secret, now)).rejects.toThrow()
  })

  it('seleciona a criacao mais recente mesmo que um historico tenha sido revalidado depois', async () => {
    const historical = { ...record, backupKey: 'neon/2026-10-29/' + 'a'.repeat(32) + '.lan', createdAt: '2026-10-29T06:30:00.000Z', validatedAt: '2026-10-30T07:59:00.000Z' }
    const send = vi.fn(async (command: GetObjectCommand | HeadObjectCommand | ListObjectsV2Command) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [
        { Key: validationKey(historical.backupKey), LastModified: now },
        { Key: validationKey(record.backupKey), LastModified: new Date(record.validatedAt) },
      ] }
      if (command instanceof GetObjectCommand) {
        const marker = encodeValidation(command.input.Key === validationKey(historical.backupKey) ? historical : record, secret)
        return { ContentLength: marker.length, Body: Readable.from([marker]) }
      }
      expect(command.input.Key).toBe(record.backupKey)
      return { ContentLength: record.archiveBytes, Metadata: { sha256: record.archiveSha256 } }
    })
    expect(await checkValidatedBackup({ send } as unknown as S3Client, 'bucket', secret, now)).toEqual(record)
  })
})
