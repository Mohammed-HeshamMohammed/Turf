# Service registry

| Service | Port | Language | Owns schema |
| --- | --- | --- | --- |
| gateway | 8100 | go | none |
| auth | 8101 | rust | auth |
| notifications | 8102 | go | notifications |
| billing | 8103 | ts | billing |
| importing-lists | 8111 | python | importing_lists |
| importing-worker | 8119 | python | none (works on importing_lists) |
| crm-core | 8107 | go | crm, importing |
| crm-merge | 8120 | go | none (crm-core's job queue: merges, assignments, upkeep) |
| crm-outbox | 8121 | go | none (crm-core's job queue: webhooks, emails, reports, scans) |
| skip-tracing | 8112 | python | skip_tracing |
| dialer-sms (every part in one, until the switch) | 8113 | go | dialer_sms |
| telnyx-phone-api | 8113 | go | dialer_sms (shared) |
| telnyx-phone-webhooks | 8122 | go | dialer_sms (shared) |
| telnyx-phone-jobs | 8123 | go | dialer_sms (shared) |
| telnyx-sms-api | 8124 | go | dialer_sms (shared) |
| telnyx-sms-webhooks | 8125 | go | dialer_sms (shared) |
| telnyx-sms-jobs | 8126 | go | dialer_sms (shared) |
| leads-map | 8114 | rust | leads_map |
| crm | 8115 | rust | crm |
| ai-campaigns | 8116 | ts | ai_campaigns |
| exports | 8117 | python | exports |
| backup-restore | 8118 | rust | backup_restore |

The gateway (8100) is the only public port. It routes `/api/v1/<service>/*` to the service of that name, after checking the token with the auth service's public keys.
