// crm-outbox (port 8121): crm-core's work that waits on other services, its own container since split 2: webhooks, email waits,
// scheduled reports, shared learning and file scans. It shares crm-core's code and database; only its queue is switched on.
package main

import crm "callerwhale/crm-core"

func main() { crm.MainJobs("outbox") }
