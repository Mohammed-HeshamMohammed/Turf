-- A list can be brought in for skip tracing: it has addresses (and names) but no phone numbers or emails yet, and finding them is the point.
-- Such a list is allowed in, and is not called "useless".
ALTER TABLE importing.jobs ADD COLUMN for_skip_tracing boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN skip_tracing boolean NOT NULL DEFAULT false;
