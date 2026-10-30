import { randomUUID } from 'node:crypto'
import pg, { type Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from '../../server/db/pool.js'
import { migrate } from '../../server/db/migrate.js'
import { configureRuntimePrivileges, runtimePrivileges } from '../../server/db/runtime-privileges.js'

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://linkatletas:linkatletas_dev@127.0.0.1:54329/linkatletas_test'
if (!decodeURIComponent(new URL(url).pathname).endsWith('_test')) {
  throw new Error('Privilegios exigem PostgreSQL isolado com sufixo _test.')
}

let pool: Pool
let client: PoolClient | undefined
let role: string
let quotedRole: string

function db() {
  if (!client) throw new Error('Conexao de teste indisponivel.')
  return client
}

async function asRuntime(sql: string, values: unknown[] = []) {
  await db().query('SAVEPOINT runtime_operation')
  try {
    await db().query(`SET LOCAL ROLE ${quotedRole}`)
    const result = await db().query(sql, values)
    await db().query('RESET ROLE')
    await db().query('RELEASE SAVEPOINT runtime_operation')
    return result
  } catch (error) {
    await db().query('ROLLBACK TO SAVEPOINT runtime_operation')
    await db().query('RELEASE SAVEPOINT runtime_operation')
    throw error
  }
}

beforeAll(async () => {
  pool = createPool(url)
  await migrate(pool)
})

afterAll(async () => { await pool?.end() })

beforeEach(async () => {
  client = await pool.connect()
  role = `runtime_test_${randomUUID().replaceAll('-', '')}`
  quotedRole = pg.escapeIdentifier(role)
  await client.query('BEGIN')
  await client.query(`CREATE ROLE ${quotedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`)
  await client.query(`GRANT ${quotedRole} TO CURRENT_USER`)
  await client.query(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`)
  expect((await client.query("SELECT pg_has_role(current_user,$1,'SET') AS permitted", [role])).rows[0].permitted).toBe(true)
})

afterEach(async () => {
  if (!client) return
  try { await client.query('ROLLBACK') } finally {
    client.release()
    client = undefined
  }
})

describe('privilegios minimos efetivos do PostgreSQL', () => {
  it('cobre exatamente as 37 tabelas e concede somente a matriz explicita', async () => {
    expect(await configureRuntimePrivileges(db(), role)).toEqual({ role, tables: 37 })
    const tables = await db().query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    expect(tables.rows.map((table) => table.tablename)).toEqual(Object.keys(runtimePrivileges).sort())
    const permissions = await db().query(`
      SELECT c.relname AS name,p.operation,has_table_privilege($1::name,c.oid,p.operation) AS permitted
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(operation)
      WHERE n.nspname='public' AND c.relkind='r'
    `, [role])
    for (const permission of permissions.rows) {
      expect(permission.permitted, `${permission.name} ${permission.operation}`).toBe(runtimePrivileges[permission.name].includes(permission.operation))
    }
  })

  it('permite criar usuario, atualizar perfil, inserir auditoria e limpar sessao', async () => {
    await configureRuntimePrivileges(db(), role)
    const user = randomUUID()
    await asRuntime('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [user, 'Teste permissoes', `${user}@example.invalid`, 'fixture', 'athlete'])
    await asRuntime('INSERT INTO profiles(user_id,city) VALUES($1,$2)', [user, 'Sao Paulo'])
    expect((await asRuntime('UPDATE profiles SET city=$1 WHERE user_id=$2 RETURNING city', ['Campinas', user])).rows[0].city).toBe('Campinas')
    await asRuntime("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [randomUUID(), user])
    expect((await asRuntime('DELETE FROM sessions WHERE user_id=$1', [user])).rowCount).toBe(1)
    await asRuntime('INSERT INTO administrative_audit(actor_id,action) VALUES($1,$2)', [user, 'Teste de permissao'])
    expect((await asRuntime('SELECT action FROM administrative_audit WHERE actor_id=$1', [user])).rows[0].action).toBe('Teste de permissao')
  })

  it.each(['administrative_audit', 'billing_audit', 'consent_history', 'consultation_history', 'review_moderation', 'review_reports', 'verification_audit'])('bloqueia UPDATE DELETE e TRUNCATE em %s', async (table) => {
    await configureRuntimePrivileges(db(), role)
    const relation = `public.${pg.escapeIdentifier(table)}`
    await expect(asRuntime(`UPDATE ${relation} SET id=id WHERE false`)).rejects.toMatchObject({ code: '42501' })
    await expect(asRuntime(`DELETE FROM ${relation} WHERE false`)).rejects.toMatchObject({ code: '42501' })
    await expect(asRuntime(`TRUNCATE ${relation}`)).rejects.toMatchObject({ code: '42501' })
  })

  it.each(['users', 'contracts', 'verifications', 'reviews', 'consultations'])('bloqueia exclusao do pai %s e impede apagar historico por cascata', async (table) => {
    await configureRuntimePrivileges(db(), role)
    await expect(asRuntime(`DELETE FROM public.${pg.escapeIdentifier(table)} WHERE false`)).rejects.toMatchObject({ code: '42501' })
  })

  it('revoga grants antigos por coluna e nao mantem grants padrao em tabelas futuras', async () => {
    await db().query(`GRANT UPDATE(action) ON administrative_audit TO ${quotedRole}`)
    await db().query(`ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO ${quotedRole}`)
    await db().query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${quotedRole}`)
    await configureRuntimePrivileges(db(), role)
    await expect(asRuntime("UPDATE administrative_audit SET action='alterada' WHERE false")).rejects.toMatchObject({ code: '42501' })
    const table = pg.escapeIdentifier(`runtime_future_${randomUUID().replaceAll('-', '')}`)
    await db().query(`CREATE TABLE public.${table}(id integer)`)
    await expect(asRuntime(`SELECT id FROM public.${table}`)).rejects.toMatchObject({ code: '42501' })
    await expect(asRuntime(`INSERT INTO public.${table}(id) VALUES(1)`)).rejects.toMatchObject({ code: '42501' })
  })

  it.each(['PUBLIC', 'inherited'])('recusa grant de coluna %s que tornaria auditoria editavel e permite rollback integral', async (source) => {
    let grantee = 'PUBLIC'
    if (source === 'inherited') {
      grantee = pg.escapeIdentifier(`grant_test_${randomUUID().replaceAll('-', '')}`)
      await db().query(`CREATE ROLE ${grantee} NOLOGIN`)
      await db().query(`GRANT ${grantee} TO ${quotedRole} WITH SET FALSE`)
    }
    await db().query(`GRANT UPDATE(action) ON administrative_audit TO ${grantee}`)
    await db().query(`GRANT DELETE ON users TO ${quotedRole}`)
    await db().query('SAVEPOINT configure_privileges')
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow('Privilegio herdado incompativel: administrative_audit UPDATE')
    await db().query('ROLLBACK TO SAVEPOINT configure_privileges')
    expect((await db().query("SELECT has_table_privilege($1,'public.users','DELETE') AS permitted", [role])).rows[0].permitted).toBe(true)
  })

  it('recusa acesso PUBLIC por coluna em tabela desconhecida', async () => {
    const table = `runtime_unknown_${randomUUID().replaceAll('-', '')}`
    await db().query(`CREATE TABLE public.${pg.escapeIdentifier(table)}(id integer)`)
    await db().query(`GRANT SELECT(id) ON public.${pg.escapeIdentifier(table)} TO PUBLIC`)
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow(`Privilegio herdado incompativel: ${table} SELECT`)
  })

  it('remove grants de tabela e de colunas em tabela desconhecida sem autorizar acesso', async () => {
    const table = pg.escapeIdentifier(`runtime_unknown_${randomUUID().replaceAll('-', '')}`)
    await db().query(`CREATE TABLE public.${table}(id integer)`)
    await db().query(`GRANT ALL ON public.${table} TO ${quotedRole}`)
    await db().query(`GRANT SELECT(id),INSERT(id),UPDATE(id),REFERENCES(id) ON public.${table} TO ${quotedRole}`)
    await configureRuntimePrivileges(db(), role)
    await expect(asRuntime(`SELECT id FROM public.${table}`)).rejects.toMatchObject({ code: '42501' })
    await expect(asRuntime(`INSERT INTO public.${table}(id) VALUES(1)`)).rejects.toMatchObject({ code: '42501' })
    await expect(asRuntime(`UPDATE public.${table} SET id=1 WHERE false`)).rejects.toMatchObject({ code: '42501' })
  })

  it.each(['SELECT', 'UPDATE(name)'])('recusa capacidade herdada de delegar %s mesmo quando a operacao e permitida', async (operation) => {
    const inherited = pg.escapeIdentifier(`grant_test_${randomUUID().replaceAll('-', '')}`)
    await db().query(`CREATE ROLE ${inherited} NOLOGIN`)
    await db().query(`GRANT ${inherited} TO ${quotedRole} WITH SET FALSE`)
    await db().query(`GRANT ${operation} ON users TO ${inherited} WITH GRANT OPTION`)
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow(`Privilegio herdado incompativel: users ${operation.startsWith('UPDATE') ? 'UPDATE' : 'SELECT'}`)
  })

  it.each([
    ['PUBLIC', ''],
    ['PUBLIC', 'IN SCHEMA public'],
    ['inherited', ''],
    ['inherited', 'IN SCHEMA public'],
  ])('recusa default ACL %s %s que reabriria tabelas futuras', async (source, scope) => {
    let grantee = 'PUBLIC'
    if (source === 'inherited') {
      grantee = pg.escapeIdentifier(`grant_test_${randomUUID().replaceAll('-', '')}`)
      await db().query(`CREATE ROLE ${grantee} NOLOGIN`)
      await db().query(`GRANT ${grantee} TO ${quotedRole} WITH SET FALSE`)
    }
    await db().query(`ALTER DEFAULT PRIVILEGES ${scope} GRANT SELECT ON TABLES TO ${grantee}`)
    await db().query(`GRANT DELETE ON users TO ${quotedRole}`)
    await db().query('SAVEPOINT configure_privileges')
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow('Privilegios padrao herdados permitem acesso a tabelas futuras.')
    await db().query('ROLLBACK TO SAVEPOINT configure_privileges')
    expect((await db().query("SELECT has_table_privilege($1,'public.users','DELETE') AS permitted", [role])).rows[0].permitted).toBe(true)
  })

  it('recusa role proprietaria de tabela antes de alterar grants', async () => {
    const table = pg.escapeIdentifier(`runtime_owned_${randomUUID().replaceAll('-', '')}`)
    await db().query(`CREATE TABLE public.${table}(id integer)`)
    await db().query(`GRANT CREATE ON SCHEMA public TO ${quotedRole}`)
    await db().query(`ALTER TABLE public.${table} OWNER TO ${quotedRole}`)
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow('Role de execucao nao pode possuir tabelas.')
  })

  it('recusa NOINHERIT com SET ROLE capaz de contornar a matriz de permissoes', async () => {
    const inherited = pg.escapeIdentifier(`grant_test_${randomUUID().replaceAll('-', '')}`)
    await db().query(`CREATE ROLE ${inherited} NOLOGIN`)
    await db().query(`ALTER ROLE ${quotedRole} NOINHERIT`)
    await db().query(`GRANT ${inherited} TO ${quotedRole} WITH INHERIT FALSE, SET TRUE`)
    await db().query(`GRANT DELETE ON users TO ${inherited}`)
    expect((await db().query("SELECT has_table_privilege($1,'public.users','DELETE') AS permitted", [role])).rows[0].permitted).toBe(false)
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow('Role de execucao pode assumir outro papel.')
  })

  it.each(['CREATEROLE', 'CREATEDB'])('recusa flag administrativa %s', async (flag) => {
    await db().query(`ALTER ROLE ${quotedRole} ${flag}`)
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow('Role de execucao possui privilegios administrativos.')
  })

  it('recusa MAINTAIN herdado quando a versao do PostgreSQL oferece esse privilegio', async (context) => {
    const version = Number((await db().query("SELECT current_setting('server_version_num') AS version")).rows[0].version)
    if (version < 170000) context.skip('MAINTAIN exige PostgreSQL 17 ou superior.')
    const inherited = pg.escapeIdentifier(`grant_test_${randomUUID().replaceAll('-', '')}`)
    await db().query(`CREATE ROLE ${inherited} NOLOGIN`)
    await db().query(`GRANT ${inherited} TO ${quotedRole} WITH SET FALSE`)
    await db().query(`GRANT MAINTAIN ON users TO ${inherited}`)
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow('Privilegio herdado incompativel: users MAINTAIN')
  })

  it.each(['schema', 'database'])('recusa CREATE efetivo em %s', async (scope) => {
    if (scope === 'schema') await db().query(`GRANT CREATE ON SCHEMA public TO ${quotedRole}`)
    else {
      const database = (await db().query('SELECT current_database() AS name')).rows[0].name
      await db().query(`GRANT CREATE ON DATABASE ${pg.escapeIdentifier(database)} TO ${quotedRole}`)
    }
    await expect(configureRuntimePrivileges(db(), role)).rejects.toThrow('Role de execucao nao pode criar objetos ou schemas.')
  })
})
