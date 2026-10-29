ALTER TABLE contracts ADD CONSTRAINT contracts_members_unique UNIQUE(id,athlete_id,coach_id);
ALTER TABLE reviews DROP CONSTRAINT reviews_contract_id_fkey;
ALTER TABLE reviews ADD CONSTRAINT reviews_contract_members_fkey
  FOREIGN KEY(contract_id,athlete_id,coach_id)
  REFERENCES contracts(id,athlete_id,coach_id) ON DELETE CASCADE;
ALTER TABLE billing_subscriptions ADD CONSTRAINT billing_subscriptions_commission_bounds
  CHECK(commission_bps BETWEEN 0 AND 5000);

DO $$
DECLARE
  relation RECORD;
  column_names TEXT;
BEGIN
  FOR relation IN
    SELECT c.conname,c.conrelid,c.conkey,r.relname,n.nspname
    FROM pg_constraint c
    JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND c.contype='f'
      AND NOT EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid=c.conrelid AND i.indisvalid
          AND i.indpred IS NULL AND i.indkey[0]=ANY(c.conkey)
      )
    ORDER BY r.relname,c.conname
  LOOP
    SELECT string_agg(format('%I',a.attname),',' ORDER BY k.position)
      INTO column_names
    FROM unnest(relation.conkey) WITH ORDINALITY AS k(attnum,position)
    JOIN pg_attribute a ON a.attrelid=relation.conrelid AND a.attnum=k.attnum;
    EXECUTE format('CREATE INDEX %I ON %I.%I (%s)',
      'idx_'||relation.conname,relation.nspname,relation.relname,column_names);
  END LOOP;
END
$$;
