import { describe, expect, it } from 'vitest'
import { migrationChecksum, verifyMigrationChecksum } from '../../server/db/migration-checksum.js'

describe('integridade dos arquivos de migration', () => {
  it('mantem o mesmo hash entre checkouts Windows e Linux', () => {
    expect(migrationChecksum('SELECT 1;\r\n')).toBe(migrationChecksum('SELECT 1;\n'))
  })

  it('recusa SQL alterado depois de aplicado', () => {
    const stored = migrationChecksum('SELECT 1;\n')
    expect(() => verifyMigrationChecksum('001_initial.sql', 'SELECT 2;\n', stored)).toThrow('Checksum divergente')
  })

  it('aceita o conteudo exato registrado', () => {
    const content = 'SELECT 1;\n'
    expect(verifyMigrationChecksum('008_example.sql', content, migrationChecksum(content))).toBe(migrationChecksum(content))
  })

  it('nao confia automaticamente em migration antiga sem baseline', () => {
    expect(() => verifyMigrationChecksum('999_unknown.sql', 'SELECT 1;', null)).toThrow('Baseline ausente')
  })

  it('recusa alteracao na baseline antes de registrar o primeiro hash', () => {
    expect(() => verifyMigrationChecksum('001_initial.sql', 'SELECT 1;', null)).toThrow('Checksum divergente')
  })
})
