-- How many times a job was picked up again after its worker stopped mid-way. A file that keeps stopping the worker (it runs out of
-- memory, say) is failed after a few tries instead of being picked up for ever.
ALTER TABLE importing.jobs ADD COLUMN attempts int NOT NULL DEFAULT 0;
