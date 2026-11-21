-- The live server (Centrifugo) now reads this table itself, with its PostgreSQL consumer, instead of this service sending each row to
-- its API. Centrifugo reads one partition at a time under an advisory lock, oldest first, and deletes what it delivered, so updates
-- about one conversation never overtake each other however many copies of it run, and different conversations go out side by side.
-- The format is Centrifugo's own: id, method, payload (the API request itself), partition, created_at.

ALTER TABLE outbox ADD COLUMN partition int NOT NULL DEFAULT 0;   -- from the conversation id: one conversation, one partition
CREATE INDEX outbox_by_partition ON outbox (partition, id);       -- what Centrifugo asks: the oldest rows of one partition

-- Every queued row carries its own number as Centrifugo's idempotency key (an update sent twice is delivered once) and wakes the
-- partition it is in. The signal is the partition number, which is what Centrifugo listens for; it waits for the commit.
CREATE FUNCTION outbox_queued() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.payload := NEW.payload || jsonb_build_object('idempotency_key', 'outbox-' || NEW.id);
  PERFORM pg_notify('messaging_outbox', NEW.partition::text);
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_queued BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_queued();
