ALTER TABLE users ADD CONSTRAINT users_id_role_unique UNIQUE(id,role);

ALTER TABLE contracts
 ADD COLUMN athlete_role TEXT GENERATED ALWAYS AS ('athlete'::text) STORED NOT NULL,
 ADD COLUMN coach_role TEXT GENERATED ALWAYS AS ('coach'::text) STORED NOT NULL;

ALTER TABLE contracts
 DROP CONSTRAINT contracts_athlete_id_fkey,
 DROP CONSTRAINT contracts_coach_id_fkey,
 ADD CONSTRAINT contracts_athlete_role_fkey FOREIGN KEY(athlete_id,athlete_role) REFERENCES users(id,role) ON DELETE CASCADE,
 ADD CONSTRAINT contracts_coach_role_fkey FOREIGN KEY(coach_id,coach_role) REFERENCES users(id,role) ON DELETE CASCADE;

ALTER TABLE messages ADD COLUMN athlete_id UUID, ADD COLUMN coach_id UUID;

UPDATE messages m SET athlete_id=c.athlete_id,coach_id=c.coach_id
 FROM contracts c WHERE c.id=m.contract_id;

ALTER TABLE messages
 ALTER COLUMN athlete_id SET NOT NULL,
 ALTER COLUMN coach_id SET NOT NULL,
 DROP CONSTRAINT messages_contract_id_fkey,
 ADD CONSTRAINT messages_contract_members_fkey FOREIGN KEY(contract_id,athlete_id,coach_id) REFERENCES contracts(id,athlete_id,coach_id) ON UPDATE CASCADE ON DELETE CASCADE,
 ADD CONSTRAINT messages_sender_participant CHECK(sender_id IN (athlete_id,coach_id));

CREATE FUNCTION public.set_message_contract_members() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
 members record;
BEGIN
 SELECT athlete_id,coach_id INTO members FROM public.contracts WHERE id=NEW.contract_id FOR KEY SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Contrato inexistente.' USING ERRCODE='23503',CONSTRAINT='messages_contract_members_fkey';
 END IF;
 NEW.athlete_id:=members.athlete_id;
 NEW.coach_id:=members.coach_id;
 RETURN NEW;
END;
$$;

CREATE TRIGGER messages_contract_members_before_write
 BEFORE INSERT OR UPDATE OF contract_id ON messages
 FOR EACH ROW EXECUTE FUNCTION public.set_message_contract_members();

ALTER TABLE billing_payments
 ADD CONSTRAINT billing_payments_nonnegative CHECK(amount_cents>=0 AND net_cents>=0 AND coach_share_cents>=0 AND platform_share_cents>=0);

ALTER TABLE billing_splits ADD CONSTRAINT billing_splits_nonnegative CHECK(amount_cents>=0);

CREATE INDEX mail_outbox_pending_delivery ON mail_outbox(next_attempt_at,created_at) WHERE sent_at IS NULL AND attempts<5;
CREATE INDEX billing_events_pending_processing ON billing_events(next_attempt_at,received_at) WHERE processed_at IS NULL;
CREATE INDEX password_resets_expiry ON password_resets(expires_at);
