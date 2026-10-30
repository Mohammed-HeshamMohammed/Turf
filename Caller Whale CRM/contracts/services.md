# Service registry

| Service | Port | Language | Owns schema |
| --- | --- | --- | --- |
| gateway | 8100 | go | none |
| auth | 8101 | rust | auth |
| notifications | 8102 | go | notifications |
| billing | 8103 | ts | billing |
| importing-lists | 8111 | python | importing_lists |
| skip-tracing | 8112 | python | skip_tracing |
| dialer-sms | 8113 | ts | dialer_sms |
| leads-map | 8114 | rust | leads_map |
| crm | 8115 | rust | crm |
| ai-campaigns | 8116 | ts | ai_campaigns |
| exports | 8117 | python | exports |
| backup-restore | 8118 | rust | backup_restore |

The gateway (8100) is the only public port. It routes `/api/v1/<service>/*` to the service of that name, after checking the token with the auth service's public keys.
