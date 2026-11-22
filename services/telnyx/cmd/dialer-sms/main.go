// dialer-sms: every part of the calls and texts service in one program, as deployed before the split into the telnyx-phone-* and
// telnyx-sms-* containers. See services/telnyx/README.md.
package main

import "callerwhale/telnyx"

func main() { telnyx.Main() }
