package telnyx

// What a call's facts mean for the CRM. The outcome labels are crm-core's (services/crm-core/ops.go, `outcomes`): the dialer
// only picks one, and crm-core decides what it does to the lead (stage, verdict, do-not-call, callback task).
//
// The rules read the facts, never the order they arrived in, so a webhook that comes late or twice changes nothing.

import (
	"slices"
	"strings"
)

// facts is everything known about a call when it is settled.
type facts struct {
	Direction        string
	Answered         bool
	Ended            bool
	AMD              string // human, machine, not_sure, silence, fax, or empty when detection was not asked for or not heard
	HangupCause      string
	HangupSource     string // caller (our side), callee (the lead), unknown
	SIPCode          string
	Transferred      bool // the closer's leg answered
	Disposition      string
	WrapupTimedOut   bool // the person did not say how it went in time
	VoicemailDropped bool
}

// The outcomes the person may choose after a call that a human answered (wrap-up). The others come from the carrier.
var dispositions = []string{"Reached", "Not interested", "Callback", "Transfer", "Language barrier", "Wrong person", "Wrong number", "Do not call", "Dead call"}

func validDisposition(label string) string {
	for _, d := range dispositions {
		if strings.EqualFold(d, strings.TrimSpace(label)) {
			return d
		}
	}
	return ""
}

var (
	busyCauses     = []string{"user_busy", "busy"}
	busySIP        = []string{"486", "600"}
	rejectedCauses = []string{"call_rejected", "rejected"}
	rejectedSIP    = []string{"603", "607", "608"}
	invalidCauses  = []string{"not_found", "unallocated_number", "invalid_number_format", "number_changed", "no_route_destination"}
	invalidSIP     = []string{"404", "410", "484", "604"}
	failureCauses  = []string{"destination_out_of_order", "network_out_of_order", "service_unavailable", "recovery_on_timer_expire"}
	noAnswerCauses = []string{"timeout", "no_answer", "originator_cancel", "time_limit"}
)

// dropped is a call a human answered that ended for a reason other than someone hanging up.
func (f facts) dropped() bool {
	if !f.Answered {
		return false
	}
	switch f.HangupCause {
	case "", "normal_clearing", "originator_cancel", "time_limit":
		return false
	}
	return true
}

// classify answers the outcome label for the CRM and whether it must wait for the person's wrap-up first. An empty label
// means the call is not logged in the CRM (a missed inbound call: there was no attempt to reach the lead).
func classify(f facts) (label string, waitForPerson bool) {
	if f.Direction == "incoming" {
		if f.Answered {
			if d := validDisposition(f.Disposition); d != "" {
				return d, false
			}
			return "Reached", false
		}
		return "", false
	}
	if f.Transferred {
		return "Transfer", false
	}
	if f.Answered {
		switch f.AMD {
		case "machine":
			return "Voicemail", false
		case "fax":
			return "Wrong number", false
		case "silence":
			return "Dead call", false
		}
		if d := validDisposition(f.Disposition); d != "" {
			return d, false
		}
		if f.Disposition == "auto" || f.WrapupTimedOut {
			if f.dropped() {
				return "Dead call", false
			}
			return "Reached", false
		}
		return "", true
	}
	// Not answered: the carrier's reason decides.
	cause, sip := strings.ToLower(f.HangupCause), f.SIPCode
	switch {
	case slices.Contains(invalidCauses, cause) || slices.Contains(invalidSIP, sip):
		return "Disconnected", false
	case slices.Contains(busyCauses, cause) || slices.Contains(busySIP, sip):
		return "Not available", false
	case slices.Contains(rejectedCauses, cause) || slices.Contains(rejectedSIP, sip):
		return "Not available", false
	case slices.Contains(failureCauses, cause) || strings.HasPrefix(sip, "5"):
		return "Dead call", false
	case slices.Contains(noAnswerCauses, cause):
		return "No answer", false
	}
	return "No answer", false
}

// reason is a short sentence for the call log: what the carrier said, in words.
func reason(f facts) string {
	switch {
	case f.Direction == "incoming" && !f.Answered:
		return "Missed inbound call"
	case f.Direction == "incoming":
		return "Inbound call"
	case f.Transferred:
		return "Transferred to a closer"
	case f.Answered && f.AMD == "machine" && f.VoicemailDropped:
		return "Answering machine; voicemail left"
	case f.Answered && f.AMD == "machine":
		return "Answering machine; hung up without a message"
	case f.dropped():
		return "The call dropped after it was answered (" + f.HangupCause + ")"
	case f.Answered:
		return "Answered by a person"
	}
	switch label, _ := classify(f); label {
	case "Disconnected":
		return "The number is not in service (" + firstNonEmpty(f.SIPCode, f.HangupCause) + ")"
	case "Not available":
		if slices.Contains(rejectedCauses, f.HangupCause) || slices.Contains(rejectedSIP, f.SIPCode) {
			return "The call was rejected"
		}
		return "Busy"
	case "Dead call":
		return "The carrier could not complete the call (" + firstNonEmpty(f.SIPCode, f.HangupCause) + ")"
	}
	if f.HangupCause == "originator_cancel" || (f.HangupSource == "caller" && !f.Answered) {
		return "Hung up before it was answered"
	}
	return "No answer"
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
