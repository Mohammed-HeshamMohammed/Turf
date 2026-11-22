-- The status page now reads the monitoring stack's own checks (alert-relay GET /probes); auth no longer checks anything itself.
DROP TABLE IF EXISTS status_probes;
