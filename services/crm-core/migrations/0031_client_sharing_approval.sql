-- Build step 23, part B: a client hears a recording only when that call is shared with them, and sees a deal's figures only when that
-- deal is (D136, D281); a list can go to its client for approval, and when the client requires it, its leads wait for it (D138).
ALTER TABLE call_events ADD COLUMN shared_with_client boolean NOT NULL DEFAULT false;
ALTER TABLE deals ADD COLUMN shared_with_client boolean NOT NULL DEFAULT false;

ALTER TABLE projects ADD COLUMN approval_status text NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none', 'sent', 'approved', 'changes'));
ALTER TABLE projects ADD COLUMN approval_note text NOT NULL DEFAULT '' CHECK (length(approval_note) <= 2000);
ALTER TABLE projects ADD COLUMN approval_at timestamptz;
ALTER TABLE projects ADD COLUMN approval_by uuid;
