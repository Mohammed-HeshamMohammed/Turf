package telnyx

import "testing"

func TestClassifyReadsTheCarriersReasons(t *testing.T) {
	cases := []struct {
		f    facts
		want string
		wait bool
	}{
		{facts{Direction: "outgoing", HangupCause: "timeout", SIPCode: "480"}, "No answer", false},
		{facts{Direction: "outgoing", HangupCause: "user_busy", SIPCode: "486"}, "Not available", false},
		{facts{Direction: "outgoing", HangupCause: "call_rejected", SIPCode: "603"}, "Not available", false},
		{facts{Direction: "outgoing", HangupCause: "unallocated_number", SIPCode: "404"}, "Disconnected", false},
		{facts{Direction: "outgoing", SIPCode: "410"}, "Disconnected", false},
		{facts{Direction: "outgoing", HangupCause: "unspecified", SIPCode: "503"}, "Dead call", false},
		{facts{Direction: "outgoing", HangupCause: "originator_cancel", SIPCode: "487", HangupSource: "caller"}, "No answer", false},
		{facts{Direction: "outgoing", Answered: true, AMD: "machine"}, "Voicemail", false},
		{facts{Direction: "outgoing", Answered: true, AMD: "fax"}, "Wrong number", false},
		{facts{Direction: "outgoing", Answered: true, AMD: "human", HangupCause: "normal_clearing"}, "", true},
		{facts{Direction: "outgoing", Answered: true, AMD: "human", Disposition: "Callback"}, "Callback", false},
		{facts{Direction: "outgoing", Answered: true, HangupCause: "unspecified", Disposition: "auto"}, "Dead call", false},
		{facts{Direction: "outgoing", Answered: true, HangupCause: "normal_clearing", WrapupTimedOut: true}, "Reached", false},
		{facts{Direction: "outgoing", Answered: true, Transferred: true, Disposition: "Not interested"}, "Transfer", false},
		{facts{Direction: "incoming", Answered: true}, "Reached", false},
		{facts{Direction: "incoming"}, "", false},
	}
	for i, c := range cases {
		got, wait := classify(c.f)
		if got != c.want || wait != c.wait {
			t.Errorf("%d: %+v: want %q %v, got %q %v", i, c.f, c.want, c.wait, got, wait)
		}
	}
}

func TestNumbersAreWrittenOneWay(t *testing.T) {
	for in, want := range map[string]string{"(512) 555-0100": "+15125550100", "1-512-555-0100": "+15125550100", "+44 20 7946 0958": "+442079460958", "555": ""} {
		if got := e164(in); got != want {
			t.Errorf("%s: %s", in, got)
		}
	}
	if derivedID("a", "b") != derivedID("a", "b") || derivedID("a", "b") == derivedID("a", "c") || !validID(derivedID("a", "b")) {
		t.Fatal("derived ids")
	}
}
