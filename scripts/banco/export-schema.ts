import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createPool } from '../../server/db/pool.js'

// Reads schema metadata only; no account, health, message or financial rows.
const pool = createPool()
try {
  const columns = (await pool.query<{
    table_name: string; column_name: string; data_type: string; udt_name: string;
    is_nullable: string; column_default: string | null;
  }>(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public'
      ORDER BY table_name,ordinal_position`)).rows
  const constraints = (await pool.query<{
    table_name: string; name: string; type: string; definition: string;
    columns: string[]; foreign_table: string | null;
  }>(`SELECT r.relname AS table_name,c.conname AS name,c.contype AS type,
      pg_get_constraintdef(c.oid) AS definition,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS columns,
      f.relname AS foreign_table
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
      LEFT JOIN pg_class f ON f.oid=c.confrelid
      WHERE n.nspname='public' AND c.contype IN ('p','u','f','c','x') ORDER BY r.relname,c.conname`)).rows
  const tables = [...new Set(columns.map((c) => c.table_name))]
  const indexes = (await pool.query<{ tablename: string; indexname: string; indexdef: string }>(
    `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
  )).rows
  const orderedColumns = [...columns].sort((a, b) => {
    const left = `${a.table_name}.${a.column_name}`
    const right = `${b.table_name}.${b.column_name}`
    return left < right ? -1 : left > right ? 1 : 0
  })
  const metadata = { tables, columns: orderedColumns, constraints, indexes }
  await mkdir('docs/evidencias/api', { recursive: true })
  await mkdir('docs/banco', { recursive: true })
  await writeFile('docs/evidencias/api/database-schema.json', JSON.stringify(metadata, null, 2) + '\n')
  const lines = ['# Dicionário do banco implementado', '',
    'Gerado por `pnpm exec tsx scripts/banco/export-schema.ts` após as migrations, consultando apenas metadados PostgreSQL. Não contém dados pessoais. As 35 tabelas de domínio e as tabelas tecnicas `schema_migrations` e `media_uploads` refletem o banco implementado.', '',
    'O [DER](../diagramas/der.mmd) resume os atributos, mas inclui todas as relações FK. O modelo de classes é conceitual; cardinalidades do DER refletem restrições físicas, incluindo referências opcionais. Campos `resource_id` polimórficos são autorizados pela aplicação e não são FKs.', '']
  for (const table of tables) {
    lines.push(`## ${table}`, '', '| Coluna | Tipo PostgreSQL | Nulo | Chave/restrição |', '|---|---|---|---|')
    for (const column of columns.filter((c) => c.table_name === table)) {
      const keys = constraints.filter((c) => c.table_name === table && c.columns.includes(column.column_name) && ['p', 'u', 'f'].includes(c.type))
      const key = keys.map((c) => c.type === 'p' ? 'PK' : c.type === 'u' ? 'UNIQUE' : `FK → ${c.foreign_table}`).join('; ')
      lines.push(`| ${column.column_name} | ${column.data_type === 'ARRAY' ? column.udt_name : column.data_type} | ${column.is_nullable === 'YES' ? 'Sim' : 'Não'} | ${key || '—'} |`)
    }
    lines.push('', 'Restrições:', '')
    for (const constraint of constraints.filter((c) => c.table_name === table))
      lines.push(`- \`${constraint.name}\`: \`${constraint.definition.replaceAll('|', '&#124;')}\`.`)
    lines.push('', 'Índices:', '')
    for (const index of indexes.filter((i) => i.tablename === table))
      lines.push(`- \`${index.indexname}\`: \`${index.indexdef.replaceAll('|', '&#124;')}\`.`)
    lines.push('')
  }
  await writeFile('docs/banco/dicionario-dados.md', lines.join('\n') + '\n')

  const source = (await readFile('docs/diagramas/der.mmd', 'utf8')).replaceAll('\r\n', '\n')
  const selected = new Map<string, string[]>()
  for (const match of source.matchAll(/^  (\w+) \{\n([\s\S]*?)^  \}/gm))
    selected.set(match[1], [...match[2].matchAll(/^\s+\w+ (\w+)/gm)].map((m) => m[1]))
  const relations = ['erDiagram']
  for (const fk of constraints.filter((c) => c.type === 'f')) {
    const tableColumns = columns.filter((c) => c.table_name === fk.table_name)
    const optional = fk.columns.some((name) => tableColumns.find((c) => c.column_name === name)?.is_nullable === 'YES')
    const unique = constraints.some((c) => c.table_name === fk.table_name && ['p', 'u'].includes(c.type) && c.columns.length === fk.columns.length && c.columns.every((name) => fk.columns.includes(name)))
    relations.push(`  ${fk.foreign_table} ${optional ? 'o|' : '||'}--${unique ? 'o|' : 'o{'} ${fk.table_name} : ${fk.columns.join('_')}`)
  }
  for (const table of tables.filter((t) => t !== 'schema_migrations')) {
    const wanted = new Set(selected.get(table) || ['id'])
    for (const constraint of constraints.filter((c) => c.table_name === table && ['p', 'f'].includes(c.type)))
      constraint.columns.forEach((name) => wanted.add(name))
    relations.push(`  ${table} {`)
    for (const column of columns.filter((c) => c.table_name === table && wanted.has(c.column_name))) {
      const keys = constraints.filter((c) => c.table_name === table && c.columns.includes(column.column_name))
      const marks = [keys.some((c) => c.type === 'p') ? 'PK' : '', keys.some((c) => c.type === 'f') ? 'FK' : '', keys.some((c) => c.type === 'u' && c.columns.length === 1) ? 'UK' : ''].filter(Boolean)
      const type = column.data_type === 'ARRAY' ? 'array' : column.data_type.replaceAll(' ', '_')
      relations.push(`    ${type} ${column.column_name}${marks.length ? ' ' + marks.join(',') : ''}`)
    }
    relations.push('  }')
  }
  await writeFile('docs/diagramas/der.mmd', relations.join('\n') + '\n')
  console.log(JSON.stringify({ tables: tables.length, columns: columns.length, foreignKeys: constraints.filter((c) => c.type === 'f').length }))
} finally {
  await pool.end()
}
