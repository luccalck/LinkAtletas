import pg from 'pg'
import type { PoolClient } from 'pg'

type Operation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

const read = ['SELECT'] as const
const append = ['SELECT', 'INSERT'] as const
const maintain = ['SELECT', 'INSERT', 'UPDATE'] as const
const mutable = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const

export const runtimePrivileges: Readonly<Record<string, readonly Operation[]>> = {
  administrative_audit: append,
  billing_audit: append,
  billing_events: maintain,
  billing_jobs: maintain,
  billing_payments: maintain,
  billing_plans: maintain,
  billing_settings: ['SELECT', 'UPDATE'],
  billing_splits: maintain,
  billing_subscriptions: maintain,
  billing_wallets: maintain,
  consent_history: append,
  consents: mutable,
  consultation_history: append,
  consultations: maintain,
  contracts: maintain,
  executions: maintain,
  exercise_blocks: ['SELECT', 'INSERT', 'DELETE'],
  mail_outbox: mutable,
  media: maintain,
  media_feedback: ['SELECT', 'INSERT', 'DELETE'],
  media_uploads: mutable,
  messages: maintain,
  metric_types: read,
  notifications: mutable,
  password_resets: mutable,
  privacy_requests: maintain,
  private_health: mutable,
  profiles: maintain,
  review_moderation: append,
  review_reports: append,
  reviews: maintain,
  schema_migrations: read,
  sessions: ['SELECT', 'INSERT', 'DELETE'],
  users: maintain,
  verification_audit: append,
  verifications: maintain,
  workouts: maintain,
}

export const applicationRuntimeRoles = ['linkatletas_production_runtime', 'linkatletas_preview_runtime'] as const

export async function configureRuntimePrivileges(client: PoolClient, role: string) {
  const found = await client.query<{
    oid: number
    privileged: boolean
    schema_create: boolean
    database_create: boolean
    can_set_role: boolean
    server_version: number
  }>(`
    SELECT r.oid,(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS privileged,
      has_schema_privilege(r.oid,'public','CREATE') AS schema_create,
      has_database_privilege(r.oid,current_database(),'CREATE') AS database_create,
      EXISTS(SELECT 1 FROM pg_roles parent WHERE parent.oid<>r.oid AND pg_has_role(r.oid,parent.oid,'SET')) AS can_set_role,
      current_setting('server_version_num')::integer AS server_version
    FROM pg_roles r WHERE r.rolname=$1
  `, [role])
  if (!found.rowCount) throw new Error('Role de execucao inexistente.')
  const access = found.rows[0]
  if (access.privileged) throw new Error('Role de execucao possui privilegios administrativos.')
  if (access.can_set_role) throw new Error('Role de execucao pode assumir outro papel.')
  const tables = await client.query<{ name: string; owner: string; columns: string[] }>(`
    SELECT c.relname AS name,pg_get_userbyid(c.relowner) AS owner,array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.oid,c.relname,c.relowner ORDER BY c.relname
  `)
  if (tables.rows.some((table) => table.owner === role)) throw new Error('Role de execucao nao pode possuir tabelas.')
  if (access.schema_create || access.database_create) throw new Error('Role de execucao nao pode criar objetos ou schemas.')
  const name = pg.escapeIdentifier(role)
  const statements: string[] = []
  for (const owner of new Set(tables.rows.map((table) => table.owner))) {
    const ownerName = pg.escapeIdentifier(owner)
    statements.push(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} REVOKE ALL PRIVILEGES ON TABLES FROM ${name}`)
    statements.push(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${name}`)
  }
  for (const table of tables.rows) {
    const relation = `public.${pg.escapeIdentifier(table.name)}`
    statements.push(`REVOKE ALL PRIVILEGES ON TABLE ${relation} FROM ${name}`)
    statements.push(`REVOKE ALL PRIVILEGES (${table.columns.map(pg.escapeIdentifier).join(',')}) ON TABLE ${relation} FROM ${name}`)
    const allowed = Object.hasOwn(runtimePrivileges, table.name) ? runtimePrivileges[table.name] : undefined
    if (allowed) statements.push(`GRANT ${allowed.join(',')} ON TABLE ${relation} TO ${name}`)
  }
  if (statements.length) await client.query(statements.join(';\n'))
  const permissions = await client.query<{
    name: string
    operation: string
    table_permitted: boolean
    column_permitted: boolean
    table_grantable: boolean
    column_grantable: boolean
  }>(`
    SELECT c.relname AS name,p.operation,
      has_table_privilege($1::name,c.oid,p.operation) AS table_permitted,
      has_table_privilege($1::name,c.oid,p.operation || ' WITH GRANT OPTION') AS table_grantable,
      CASE WHEN p.operation IN ('SELECT','INSERT','UPDATE','REFERENCES')
        THEN has_any_column_privilege($1::name,c.oid,p.operation) ELSE false END AS column_permitted,
      CASE WHEN p.operation IN ('SELECT','INSERT','UPDATE','REFERENCES')
        THEN has_any_column_privilege($1::name,c.oid,p.operation || ' WITH GRANT OPTION') ELSE false END AS column_grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')${access.server_version >= 170000 ? ",('MAINTAIN')" : ''}) p(operation)
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
    ORDER BY c.relname,p.operation
  `, [role])
  for (const permission of permissions.rows) {
    const allowed = Object.hasOwn(runtimePrivileges, permission.name) ? runtimePrivileges[permission.name] : undefined
    const expected = Boolean(allowed?.includes(permission.operation as Operation))
    if (permission.table_grantable || permission.column_grantable || permission.table_permitted !== expected ||
      (['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(permission.operation) && permission.column_permitted !== expected)) {
      throw new Error(`Privilegio herdado incompativel: ${permission.name} ${permission.operation}`)
    }
  }
  const defaults = await client.query(`
    SELECT d.oid FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype='r' AND (d.defaclnamespace=0 OR n.nspname='public')
      AND (d.defaclrole IN (SELECT relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p'))
        OR d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user))
      AND (a.grantee=0 OR a.grantee=$1::oid OR
        CASE WHEN a.grantee=0 THEN false ELSE pg_has_role($1::oid,a.grantee,'USAGE') END)
    LIMIT 1
  `, [found.rows[0].oid])
  if (defaults.rowCount) throw new Error('Privilegios padrao herdados permitem acesso a tabelas futuras.')
  return { role, tables: tables.rows.length }
}

export async function configureApplicationRuntimePrivileges(client: PoolClient) {
  const database = (await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0].name
  const role = database === 'neondb' ? applicationRuntimeRoles[0] : database === 'linkatletas_preview' ? applicationRuntimeRoles[1] : undefined
  if (!role) return
  const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])
  if (found.rowCount) await configureRuntimePrivileges(client, role)
}
