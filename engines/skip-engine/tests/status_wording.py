"""Call statuses as dialers and CRMs write them, with the meaning a person would choose.

Used to measure how call statuses are read (tests/test_status_meaning.py). Written separately from the model's
examples in callerwhale_matching/status_meaning.py, so the model is measured on wording it has not been given. ``None`` marks
a status only the person can settle: it must never be confirmed automatically.
"""

WRONG, PERSON, DISCO, DNC, REACHED, VM, NA = "wrong_number", "wrong_person", "disconnected", "do_not_call", "reached", "voicemail", "no_answer"

LABELLED: list[tuple[str, list[str] | None]] = [
    # the number is not this lead's
    ("Wrong Number", [WRONG]), ("WRONG #", [WRONG]), ("wrong num", [WRONG]), ("WN", [WRONG]), ("Bad Number", [WRONG]), ("Bad #", [WRONG]),
    ("invalid number", [WRONG]), ("Not a valid number", [WRONG]), ("Fax tone", [WRONG]), ("Fax/Modem", [WRONG]),
    ("No one by that name here", [WRONG]), ("Doesn't know the owner", [WRONG]), ("Wrong number, asked to be removed", [WRONG, DNC]),
    ("Do Not Call - Wrong Number", [WRONG]), ("DNC: wrong number", [WRONG]), ("W#", [WRONG]),
    # the number is right, the person is not
    ("Wrong Person", [PERSON]), ("Wrong party", [PERSON]), ("Not the owner", [PERSON]), ("Owner moved", [PERSON]),
    ("Owner doesn't live here", [PERSON]), ("Incorrect info", [PERSON]), ("wrong contact", [PERSON]), ("WP", [PERSON]),
    # the line does not work
    ("Disconnected", [DISCO]), ("Disco", [DISCO]), ("DISC", [DISCO]), ("Number Disconnected", [DISCO]), ("Not in service", [DISCO]),
    ("NIS", [DISCO]), ("Out of service", [DISCO]), ("No longer in service", [DISCO]), ("Fast Busy", [DISCO]), ("Number not working", [DISCO]),
    ("Call cannot be completed", [DISCO]), ("Deactivated", [DISCO]), ("Line dead", [DISCO]), ("Temporarily out of service", [DISCO]),
    # asked not to be called
    ("DNC", [DNC]), ("Do Not Call", [DNC]), ("Do-Not-Call", [DNC]), ("DO NOT CALL!!", [DNC]), ("Don't call", [DNC]), ("Stop calling", [DNC]),
    ("Remove from list", [DNC]), ("Remove me", [DNC]), ("Take off list", [DNC]), ("Opt-Out", [DNC]), ("Opted out", [DNC]),
    ("Unsubscribe", [DNC]), ("Litigator", [DNC]), ("TCPA", [DNC]), ("Threatened lawsuit", [DNC]), ("Attorney", [DNC]),
    ("National DNC", [DNC]), ("Internal DNC", [DNC]), ("DNC Request", [DNC]), ("DNC: Do Not Call", [DNC]), ("DNC - Litigator", [DNC]),
    ("Never call again", [DNC]), ("Blacklisted", [DNC]), ("Cease and desist", [DNC]), ("DNC until 10/07/2025", [DNC]),
    ("Asked to be removed", [DNC]), ("Quit calling me", [DNC]),
    # a person answered
    ("Not Interested", [REACHED]), ("NI", [REACHED]), ("Not interested in selling", [REACHED]), ("No interest", [REACHED]),
    ("Interested", [REACHED]), ("Very interested", [REACHED]), ("Hot", [REACHED]), ("Warm lead", [REACHED]), ("Call back", [REACHED]),
    ("Callback requested", [REACHED]), ("CB tomorrow", [REACHED]), ("Follow up", [REACHED]), ("F/U next month", [REACHED]),
    ("Appointment", [REACHED]), ("Appt Set", [REACHED]), ("Offer made", [REACHED]), ("Sent offer", [REACHED]), ("Under contract", [REACHED]),
    ("Sold", [REACHED]), ("Already sold", [REACHED]), ("Listed", [REACHED]), ("Listed with agent", [REACHED]), ("Has realtor", [REACHED]),
    ("Off market", [REACHED]), ("Not selling", [REACHED]), ("Not ready to sell", [REACHED]), ("Wants retail", [REACHED]),
    ("Price too high", [REACHED]), ("Spoke with owner", [REACHED]), ("Talked to homeowner", [REACHED]), ("Hung up", [REACHED]), ("HU", [REACHED]),
    ("Rude", [REACHED]), ("Spanish", [REACHED]), ("Spanish speaker", [REACHED]), ("Language barrier", [REACHED]), ("Gatekeeper", [REACHED]),
    ("Qualified", [REACHED]), ("Negotiating", [REACHED]), ("Motivated", [REACHED]), ("Unmotivated", [REACHED]), ("Live transfer", [REACHED]),
    ("Transfer", [REACHED]), ("Trans", [REACHED]), ("Transferred to appointments", [REACHED]), ("Xfer", [REACHED]),
    ("Answered", [REACHED]), ("Left message with son", [REACHED]), ("Called back, not interested", [REACHED]),
    ("Interested - call back next week", [REACHED]), ("Spoke w/ owner - not selling", [REACHED]), ("No Eng", [REACHED]), ("RCB", [REACHED]),
    ("Not interested - hung up", [REACHED]), ("Angry", [REACHED]),
    # a message was left
    ("Voicemail", [VM]), ("VM", [VM]), ("LVM", [VM]), ("Left VM", [VM]), ("Left voicemail", [VM]), ("Left message", [VM]), ("LM", [VM]),
    ("Answering Machine", [VM]), ("Machine", [VM]), ("Mailbox full", [VM]), ("VM full", [VM]), ("VM not set up", [VM]), ("Left msg", [VM]),
    ("LMCB", [VM]), ("No answer / left VM", [VM, NA]),
    # rang without a person
    ("No Answer", [NA]), ("NA", [NA]), ("No Ans", [NA]), ("Busy", [NA]), ("Line busy", [NA]), ("Rang out", [NA]), ("Ring no answer", [NA]),
    ("No pickup", [NA]), ("Didn't answer", [NA]), ("Unanswered", [NA]), ("Dead air", [NA]), ("Dropped", [NA]), ("Could not reach", [NA]),
    ("Not available", [NA]), ("Unavailable", [NA]), ("Call failed", [NA]), ("Abandoned", [NA]), ("Not connected", [NA]),
    ("Never answered", [NA]), ("No response", [NA]), ("Not reached", [NA]), ("Dead Call", [NA]),
    # nobody called yet
    ("Not yet reached", []), ("Not called", []), ("Not called yet", []), ("New", []), ("New Lead", []), ("Uncalled", []), ("Pending", []),
    ("N/A", []), ("Untouched", []), ("Never dialed", []),
    # only the person can say
    ("DNC: interested", None), ("DNC: spanish speaker", None), ("DNC until 10/07/2025:Not interested", None), ("DNC: sold", None),
    ("DNC - listed", None), ("DNC: deceased", None), ("Deceased", None), ("Called", None), ("Tenant", None), ("Other", None), ("Misc", None),
    ("Bad lead", None), ("Duplicate", None), ("Skip", None), ("Attempted", None), ("Complete", None), ("Done", None), ("Closed", None),
    ("Dead", None), ("No contact", None), ("Hold", None), ("Archived", None), ("Spoke to tenant", None), ("VM - call back", None),
    ("Wrong number - hung up", None), ("Passed away", None), ("Do not mail", None), ("Business", None), ("Relative answered", [REACHED]),
    ("Requested no calls", [DNC]),
]

# Wording the phrase rules do not know, as people type it into a CRM. Measures the model's guesses, which are offered
# but never confirmed automatically: a wrong guess costs a click, a missing one costs nothing.
UNFAMILIAR: list[tuple[str, list[str] | None]] = [
    ("owner said he would think about it", [REACHED]), ("seller wants to wait till spring", [REACHED]), ("call me in 6 months", [REACHED]),
    ("send me something in writing", [REACHED]), ("he wants 300k", [REACHED]), ("not a good time", [REACHED]), ("she cussed me out", [REACHED]),
    ("asked who gave us his number", [REACHED]), ("lady said maybe next year", [REACHED]), ("owner is thinking", [REACHED]),
    ("number belongs to a pizza place", [WRONG]), ("lady said I have the wrong guy", [PERSON]), ("not his phone", [WRONG]),
    ("recording says number changed", [DISCO]), ("this number is no longer active", [DISCO]), ("tone then nothing", None),
    ("went straight to vm", [VM]), ("full mailbox", [VM]), ("greeting only", [VM]),
    ("phone just rings", [NA]), ("nobody picked", [NA]), ("no one home", [NA]), ("rings forever", [NA]),
    ("he said never contact him again", [DNC]), ("put me on your do not call", [DNC]), ("take my number off", [DNC]),
    ("owner in hospital", None), ("kid answered", None), ("elderly and confused", None), ("in jail", None), ("who is this", None),
    ("number is for a business", None), ("foreclosure", None), ("probate", None), ("vacant", None),
]
