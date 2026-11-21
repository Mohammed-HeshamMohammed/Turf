// crm-merge (port 8120): the heavy database work of crm-core, its own container since split 2: lead and call merges, lead
// assignments, and the import-row sweep and learning copies. It shares crm-core's code and database; only its queues are switched on.
package main

import crm "callerwhale/crm-core"

func main() { crm.MainJobs("merge") }
