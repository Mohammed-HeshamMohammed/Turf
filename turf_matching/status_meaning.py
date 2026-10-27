"""What a call status means, and whether Turf can be sure of it.

Dialers write their own words for a call's result: "LVM", "DNC: wrong number", "Not interested", "Disco". Three readers
look at each status, most trusted first:

1. Memory: what the person chose for the same wording in any list of the project. Their decision always wins.
2. Phrase rules: known dialer wording, with abbreviations spelled out. The rules are sure only when every word of the
   status is part of a known phrase or carries no meaning ("call", "owner", a date), and the phrases do not contradict
   each other. One unknown word is enough to leave the status for the person.
3. An optional embedding model compares the status with labelled examples and with the person's earlier decisions. It
   confirms the rules, flags a disagreement, or offers a guess for wording the rules do not know. On its own it only
   settles a near copy of something the person already decided.

A status is confirmed automatically only when the readers agree. Do-not-call is never dropped on a guess: a meaning
that any reader gives as do-not-call keeps it until the person says otherwise.

"DNC" is often a dialer's bucket for "stop dialing", with the real reason after it: "DNC: interested",
"DNC: spanish speaker". Such a status keeps do-not-call (the safe side) but is always left for the person, because only
they know whether someone asked not to be called or the dialer only stopped calling.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Sequence

NEGATIVE = ("wrong_number", "wrong_person", "disconnected")
ORDER = ("wrong_number", "wrong_person", "disconnected", "do_not_call", "reached", "voicemail", "no_answer")
LABELS = {"wrong_number": "wrong number", "wrong_person": "wrong person", "disconnected": "disconnected", "do_not_call": "do not call",
          "reached": "reached a person", "voicemail": "voicemail", "no_answer": "no answer"}

# Takes texts, returns one unit-length vector per text, as a 2-D numpy array.
Embed = Callable[[Sequence[str]], object]


@dataclass(frozen=True)
class Reading:
    outcomes: list[str]
    sure: bool
    source: str          # who decided: "memory", "rules", "rules+model", "model" or "none"
    why: str             # one sentence for the person; empty when there is nothing to add
    doubt: str = ""      # why it is not sure: "unknown", "unknown_words", "mixed", "dnc_reason", "model_disagrees", "guess"


# ------------------------------------------------------------------------------------------------- spelling it out

_BEFORE = [  # forms that lose their meaning once punctuation is gone
    (re.compile(r"\bn/a\b"), " notapplicable "), (re.compile(r"\bv/m\b"), " voicemail "), (re.compile(r"\bw/o\b"), " without "),
    (re.compile(r"\bw/"), " with "), (re.compile(r"\bf/u\b"), " follow up "), (re.compile(r"\bw ?#"), " wrong number "),
    (re.compile(r"#"), " number "), (re.compile(r"[’']"), ""),
]
ABBREVIATIONS = {
    "lvm": "left voicemail", "lm": "left message", "lmom": "left message", "lmcb": "left message", "lmtcb": "left message",
    "vm": "voicemail", "vmail": "voicemail", "voicemails": "voicemail", "amd": "answering machine", "msg": "message", "mssg": "message",
    "na": "no answer", "nans": "no answer", "noans": "no answer", "rna": "no answer", "ans": "answer", "bz": "busy", "bsy": "busy",
    "ni": "not interested", "nint": "not interested", "notinterested": "not interested",
    "cb": "call back", "rcb": "call back", "callback": "call back", "callbacks": "call back", "followup": "follow up", "fu": "follow up",
    "wn": "wrong number", "wrongnumber": "wrong number", "wrng": "wrong", "num": "number", "nbr": "number", "ph": "phone",
    "wp": "wrong person", "wrongperson": "wrong person", "inc": "incorrect", "info": "information",
    "disc": "disconnected", "disco": "disconnected", "discon": "disconnected", "discont": "disconnected", "dsc": "disconnected",
    "nis": "not in service", "oos": "out of service",
    "appt": "appointment", "appts": "appointment", "hu": "hung up", "hungup": "hung up", "hangup": "hung up",
    "trans": "transfer", "xfer": "transfer", "xfered": "transferred", "xferred": "transferred",
    "eng": "english", "spn": "spanish", "esp": "spanish", "dnt": "dont", "donot": "do not", "pls": "please",
}

# Words that say nothing about the result on their own.
FILLER = frozenset("""
a an the to of and or with for on at by in is was be been are per said says he she they them him her his their it its i we me
us you my our your call called calls calling dial dialed dialled dialing lead leads status owner owners homeowner seller sellers
client contact prospect person phone phones number numbers line result disposition dispo until till through thru exp expires
expired [date] date again yet now today still just also only very please attempt attempts attempted ok okay did does do has have
had re about from that this there here so but as if then than after before when agent rep va sms text texted texting via time
times one two three first second third final last st nd rd th campaign list record property house home
""".split())

# (phrase, meaning). Tried in order; a phrase that matches uses up its words, so "not interested" is read once, not
# also as "interested", and "not yet reached" is not read as "reached". "not_tried" is a row nobody has called yet.
_PHRASES: list[tuple[str, str]] = [
    # the line does not work
    (r"(not|no longer|isnt|is not) (in service|in use|working|active)", "disconnected"),
    (r"(temporarily )?(out of service|disconnected|deactivated|dead line|dead number|fast busy)", "disconnected"),
    (r"(number|line|phone) (has been )?(changed|disconnected|not working|doesnt work|does not work|is dead|dead)", "disconnected"),
    (r"intercept( message)?|(cannot|cant|could not|couldnt) be completed|not a working number|unreachable number", "disconnected"),
    # the number is not this lead's
    (r"(wrong|bad|invalid|incorrect) (number|phone( number)?|no)", "wrong_number"),
    (r"(not a valid|no valid|not valid) (number|phone)?", "wrong_number"),
    (r"fax( machine| tone| line)?|modem", "wrong_number"),
    (r"no ?(one|body) (here )?(by|with|named) (that|this|the) name", "wrong_number"),
    (r"(doesnt|does not|dont|do not) know (the |this )?(owner|person|them|him|her)|never heard of (them|him|her|the owner|owner)", "wrong_number"),
    (r"invalid", "wrong_number"),
    # the number is right, the person is not
    (r"(wrong|incorrect) (person|party|contact|name|owner|individual|information)", "wrong_person"),
    (r"not (the )?(owner|homeowner|right person|correct person|decision maker)", "wrong_person"),
    (r"(owner )?(doesnt|does not|no longer) (live|lives|reside|resides) (here|there)|(owner )?moved( out| away)?", "wrong_person"),
    # asked not to be called
    (r"(do not|dont|never|stop|quit) (call|calling|contact|contacting|dial|text|texting)( again| anymore| me)?", "do_not_call"),
    (r"(requested|asked for|wants?) no (more )?(calls|call|contact)|no more (calls|call|contact)", "do_not_call"),
    (r"(remove|take) (me |my number |number |them |him |her )?(off |from )?(the |your |our |calling |call )*(list|database|records)", "do_not_call"),
    (r"(remove|take) (me|my number|them|him|her)( off)?", "do_not_call"),
    (r"(asked|requested|wants?|wanted) (to be )?(removed|taken off)", "do_not_call"),
    (r"(opt|opted) ?out|unsubscribed?|cease( and desist)?|litigator|tcpa|lawyer|attorney|lawsuit|sue|harass(ment|ing|ed)?|threatened|threat", "do_not_call"),
    (r"((federal|national|state|internal|company) )?(dnc|do not call)( list| registry| request(ed)?)?", "do_not_call"),
    (r"black ?list(ed)?", "do_not_call"),
    # nobody has been called yet
    (r"not yet (called|dialed|contacted|reached|attempted|worked|tried)", "not_tried"),
    (r"(not|never) (been )?(called|dialed|contacted|attempted|worked|tried|started)( yet)?", "not_tried"),
    (r"no (attempt|attempts|calls)( made| yet)?|un(called|dialed|worked|touched|tried|attempted|contacted)", "not_tried"),
    (r"ready to (call|dial)|to be called|not yet", "not_tried"),
    # rang without a person
    (r"(no|not|never) (reached|connected|connect|contact made|pick ?up|pickup|response)", "no_answer"),
    (r"(didnt|did not|doesnt|does not|wont|would not|not|never) (answer|answered|answering|pick up|pickup|picked up)", "no_answer"),
    (r"(could not|couldnt|cannot|cant|unable to) (reach|connect|get through)", "no_answer"),
    (r"no ?(one|body) (answered|home|picked up)", "no_answer"),
    (r"no answer|unanswered|ring(ing|s)? (out|no answer)|rang( out)?|(line )?busy( signal)?|dead (air|call)|dropped( call)?|abandon(ed)?|silence|(not |un)available|call failed|failed", "no_answer"),
    # a message was left
    (r"left (a )?(message|voicemail|voice mail) (with|for) (the |his |her )?(wife|husband|spouse|son|daughter|relative|family|someone|assistant|tenant|mother|father|mom|dad|brother|sister|roommate)", "reached"),
    (r"left (a )?(voicemail|voice mail|message|vm)|message left|voicemail left", "voicemail"),
    (r"(voicemail|voice mail|answering machine|machine|mailbox)( box)?( is)?( full| not set up| not setup| no message| picked up)?", "voicemail"),
    (r"no (voicemail|vm)", "voicemail"),
    # a person answered
    (r"not interested|no interest|uninterested|unmotivated|no motivation|not motivated", "reached"),
    (r"not (selling|looking to sell|ready to sell|ready|for sale)|(wont|will not|doesnt want to|does not want to) sell", "reached"),
    (r"((somewhat|very|highly) )?(interested|motivated)", "reached"),
    (r"hung up( on (me|us|agent|rep))?|hang up", "reached"),
    (r"((requested|wants|asked for) (a )?)?call back( later| requested| scheduled| tomorrow| next week)?", "reached"),
    (r"follow up( later| needed| scheduled)?", "reached"),
    (r"appointment( set| booked| scheduled| made)?|booked|qualified|nurture|negotiat[a-z]*", "reached"),
    (r"((made|sent|verbal) (an )?)?offer( made| sent| accepted| rejected| declined| too low)?", "reached"),
    (r"(under )?contract|closed deal|deal closed|(already )?sold( it| the house| the property| already)?", "reached"),
    (r"(already )?listed( with (an |a )?(agent|realtor|broker))?|(has|with) (an |a )?(agent|realtor|broker)|off (the )?market", "reached"),
    (r"(wants|want|asking|asked) (too much|more|retail|full price)|price too high", "reached"),
    (r"(spoke|spoken|talked|speaking|talking) (with|to)|spoke|talked|conversation|answered|connected|contacted|reached", "reached"),
    (r"live (answer|person|call|contact)", "reached"),
    # handed to a closer or the appointments team (ReadyMode "Transfer")
    (r"((live|warm|hot) )?transfer(red|s)?( to (appointments?|closer|manager|acquisitions))?", "reached"),
    (r"(spanish|chinese|vietnamese|korean|russian|portuguese|french|arabic|creole|foreign language|other language|language barrier|no english|english)( speaker| speaking| only)?", "reached"),
    (r"gatekeeper|rude|angry|upset|yelled|cursed|cussed", "reached"),
    (r"(hot|warm)( lead)?", "reached"),
]
_COMPILED = [(re.compile(rf"(?<![a-z0-9\[])(?:{pattern})(?![a-z0-9\]])"), meaning) for pattern, meaning in _PHRASES]
# Whole statuses that mean nobody has been called.
_UNTRIED = frozenset({"new", "new lead", "open", "pending", "queued", "fresh", "fresh lead", "none", "blank", "null", "notapplicable", "unworked", "untouched", "not started"})
# "DNC: <reason>", "DNC - <reason>", "DNC until [date]: <reason>", "DNC until [date] <reason>"
_BUCKET = re.compile(r"^\s*(dnc|do not call)\s*(?P<date>(until|till|thru|through) \[date\])?\s*(?P<sep>[:\-/|>,;(]+)?\s*(?P<reason>.*?)[)\s]*$")


def canonical(key: str) -> str:
    """The wording without punctuation and spacing, so "DNC: wrong number" and "dnc - wrong number" are one status."""
    return re.sub(r"[^a-z0-9\[\]]+", " ", str(key).casefold()).strip()


def spell_out(key: str) -> str:
    """The status with punctuation removed and dialer abbreviations written in full."""
    text = str(key).casefold()
    for pattern, replacement in _BEFORE:
        text = pattern.sub(replacement, text)
    words = re.sub(r"[^a-z0-9\[\]]+", " ", text).split()
    return " ".join(ABBREVIATIONS.get(word, word) for word in words)


def dnc_reason(key: str) -> str | None:
    """The reason after a DNC label ("DNC: interested" → "interested"), or None when the status is not one."""
    match = _BUCKET.match(str(key).casefold())
    if not match or not match.group("reason") or not (match.group("sep") or match.group("date")):
        return None
    return match.group("reason")


def _find(text: str) -> tuple[set[str], list[str]]:
    """The meanings of the known phrases in a spelled-out status, and the words no phrase explains."""
    if text in _UNTRIED:
        return {"not_tried"}, []
    meanings: set[str] = set()
    rest = f" {text} "
    for pattern, meaning in _COMPILED:
        while (match := pattern.search(rest)) and match.group(0).strip():
            meanings.add(meaning)
            rest = rest[:match.start()] + " " * (match.end() - match.start()) + rest[match.end():]
    return meanings, [word for word in rest.split() if word not in FILLER and not word.isdigit()]


def sort_outcomes(outcomes) -> list[str]:
    """Outcomes in one fixed order, without repeats."""
    chosen = set(outcomes)
    return [kind for kind in ORDER if kind in chosen]


def _quote(text: str) -> str:
    return f"“{text.strip()}”"


def read_rules(key: str) -> Reading:
    """What the phrase rules make of one status, and whether every word of it was understood."""
    if not spell_out(key):
        return Reading([], False, "none", "The status is empty", "unknown")
    reason = dnc_reason(key)
    if reason is not None:
        return _read_dnc_reason(key, reason)
    meanings, leftover = _find(spell_out(key))
    if not meanings:
        return Reading([], False, "none", "Turf does not know this wording", "unknown")
    negatives = [kind for kind in NEGATIVE if kind in meanings]
    mixed = ""
    if negatives:
        outcomes = negatives + (["do_not_call"] if "do_not_call" in meanings else [])
        if meanings & {"reached", "not_tried"}:
            mixed = "it says both that the number is bad and that someone answered"
    elif meanings == {"not_tried"}:
        outcomes = []
    else:
        outcomes = [kind for kind in ("do_not_call", "reached", "voicemail", "no_answer") if kind in meanings]
        if "reached" in outcomes and "no_answer" in outcomes:
            outcomes.remove("no_answer")
            mixed = "it says both that someone answered and that nobody did"
        elif "reached" in outcomes and "voicemail" in outcomes:
            mixed = "it says both that someone answered and that a message was left"
        elif "not_tried" in meanings and outcomes:
            mixed = "it says the number was not called yet, and also how a call went"
    if mixed:
        return Reading(sort_outcomes(outcomes), False, "rules", f"Mixed meanings: {mixed}", "mixed")
    if leftover:
        return Reading(sort_outcomes(outcomes), False, "rules", f"Unknown words: {', '.join(leftover[:4])}", "unknown_words")
    return Reading(sort_outcomes(outcomes), True, "rules", "Not called yet, so there is no call result to record" if meanings == {"not_tried"} else "")


def _read_dnc_reason(key: str, reason: str) -> Reading:
    meanings, leftover = _find(spell_out(reason))
    negatives = [kind for kind in NEGATIVE if kind in meanings]
    if negatives:
        # The dialer stopped because the number is bad, which blocks it already.
        sure = not leftover and "reached" not in meanings
        return Reading(sort_outcomes(negatives + (["do_not_call"] if "do_not_call" in meanings else [])), sure, "rules",
                       "" if sure else f"Not every word of {_quote(key)} is known", "" if sure else "unknown_words")
    if meanings == {"do_not_call"} and not leftover:
        return Reading(["do_not_call"], True, "rules", "")
    outcomes = {"do_not_call"} | (meanings & {"reached", "voicemail", "no_answer"})
    if "reached" in outcomes:
        outcomes.discard("no_answer")
    return Reading(sort_outcomes(outcomes), False, "rules",
                   f"Starts with DNC, but the reason is {_quote(reason)}. Keep Do not call only if the person asked not to be called; "
                   "the dialer may only have stopped dialing", "dnc_reason")


# ------------------------------------------------------------------------------------------------------- examples

# Plain, unambiguous wording for each meaning: what the model compares a status with. The tests measure accuracy on
# other wording, so nothing here is copied from them.
EXAMPLES: list[tuple[str, tuple[str, ...]]] = [
    *((text, ("wrong_number",)) for text in ("wrong number", "bad number", "invalid phone number", "no one by that name", "fax machine",
                                              "number belongs to someone else", "this is not their number", "never heard of the owner")),
    *((text, ("wrong_person",)) for text in ("wrong person", "wrong party", "not the owner", "owner moved away", "owner does not live here",
                                              "talked to the new owner not our seller", "incorrect contact person")),
    *((text, ("disconnected",)) for text in ("disconnected", "number not in service", "out of service", "line is dead", "fast busy",
                                              "call cannot be completed as dialed", "number no longer in service", "phone deactivated")),
    *((text, ("do_not_call",)) for text in ("do not call", "dnc", "stop calling me", "remove me from your list", "take me off the list",
                                             "opt out", "unsubscribe", "threatened to sue", "attorney said stop", "on national dnc registry",
                                             "never call again", "litigator")),
    *((text, ("reached",)) for text in ("not interested", "interested", "call back later", "appointment set", "made an offer",
                                         "spoke with owner", "hung up on me", "already sold the house", "listed with an agent",
                                         "not looking to sell", "wants too much money", "under contract", "spanish speaker",
                                         "talked to seller", "hot lead", "motivated seller", "follow up next month", "gatekeeper answered",
                                         "rude", "maybe later", "thinking about it", "will consider selling", "send info by mail",
                                         "asked for a cash offer", "deal closed", "call transferred to the closer")),
    *((text, ("voicemail",)) for text in ("left voicemail", "voicemail", "left message", "answering machine", "voicemail full",
                                           "mailbox not set up", "machine picked up")),
    *((text, ("no_answer",)) for text in ("no answer", "busy", "rang out", "no pickup", "dead air", "dropped call", "nobody answered",
                                           "line busy", "could not reach", "call failed", "dead call nobody on the line")),
    *((text, ()) for text in ("not called yet", "new lead", "untouched", "pending", "not yet dialed", "fresh lead")),
]


# ----------------------------------------------------------------------------------------------- putting it together

# How alike two spelled-out statuses must be (cosine similarity of the model's vectors). Tuned on the labelled
# wording in tests/status_wording.py; tests/test_status_meaning.py checks that no automatic reading there is wrong,
# also with the agreement threshold moved either way.
AGREE = 0.75        # the closest example agrees with the rules: a few unknown words do not matter
DISAGREE = 0.85     # the model is this sure of another meaning: the rules are not trusted alone
GUESS = 0.80        # wording the rules do not know, like something the person decided: offered as a guess
NEAR_COPY = 0.93    # wording the rules do not know, almost the same as something the person decided: settled
TIE = 0.08          # neighbours this close to the best must agree with it
# A guess comes only from the person's own decisions. Measured on unfamiliar wording, the model's closest built-in
# example was too often wrong ("owner said he would think about it" reads like "not the owner"), and a wrong meaning
# filled in for the person costs more than a blank one.


# ------------------------------------------------------------------------------------------------- earlier version

# What Turf suggested before these readers (skiptrace version 4), kept only to tell its old suggestions apart from
# what the person chose in setups and drafts saved then: a saved meaning equal to the old suggestion is replaced by
# today's reading; one that differs was the person's and is kept.
_EARLIER_WRONG = re.compile(r"wrong\s*(number|#|no\b|person)|bad number|invalid number|disconnected|not in service|out of service|no longer in service|number (is )?not (valid|working)|\bfax\b|unreachable number")
_EARLIER_UNTRIED = re.compile(r"not yet|not called|untouched|no attempt|never called|new lead|queued|not started|pending|^new$|^open$|^unworked$|ready to call")
_EARLIER_DNC = re.compile(r"\bdnc\b|do not call|don't call|dont call|do-not-call|stop calling|remove (me|from)|\bcease\b|opt[- ]?out|unsubscribe|litigator|\btcpa\b|never call|no more calls")
_EARLIER_REACHED = re.compile(r"interested|appointment|call ?back|follow ?up|\boffer|contract|\bsold\b|spoke|talked|answered|contacted|connected|conversation|qualified|booked|nurture|negotiat")


def earlier_outcomes(key: str) -> list[str]:
    """The meaning the earlier version of Turf suggested for a status key."""
    if _EARLIER_WRONG.search(key):
        return ["wrong_number"]
    if _EARLIER_UNTRIED.search(key) and not _EARLIER_DNC.search(key):
        return []
    return [kind for kind, pattern in (("do_not_call", _EARLIER_DNC), ("reached", _EARLIER_REACHED)) if pattern.search(key)]


def _model_text(key: str) -> str:
    reason = dnc_reason(key)
    return spell_out(reason if reason is not None else key)


def read_statuses(keys: Sequence[str], memory: dict[str, dict] | None = None, embed: Embed | None = None) -> dict[str, Reading]:
    """One reading per status. `memory` maps canonical wording to {"key", "outcomes", "list"} the person chose."""
    memory = memory or {}
    readings: dict[str, Reading] = {}
    pending: list[tuple[str, Reading]] = []
    for key in keys:
        decided = memory.get(canonical(key))
        if decided is not None:
            where = f" on {_quote(decided['list'])}" if decided.get("list") else ""
            readings[key] = Reading(sort_outcomes(decided.get("outcomes") or []), True, "memory", f"You chose this{where}")
        else:
            pending.append((key, read_rules(key)))
    if embed is None or not pending:
        readings.update(pending)
        return readings
    import numpy as np  # the model brings numpy with it

    labelled = [(text, tuple(sort_outcomes(meaning)), False) for text, meaning in EXAMPLES]
    labelled += [(str(entry.get("key") or text), tuple(sort_outcomes(entry.get("outcomes") or [])), True) for text, entry in memory.items()]
    vectors = np.asarray(embed([_model_text(text) for text, _, _ in labelled] + [_model_text(key) for key, _ in pending]), dtype=np.float32)
    scores = vectors[len(labelled):] @ vectors[:len(labelled)].T
    for row, (key, rules) in enumerate(pending):
        order = np.argsort(-scores[row])[:3]
        best = int(order[0])
        top = float(scores[row, best])
        agree = all(labelled[int(other)][1] == labelled[best][1] for other in order[1:] if float(scores[row, int(other)]) >= top - TIE)
        readings[key] = combine(rules, top, labelled[best][0], list(labelled[best][1]), labelled[best][2], agree)
    return readings


def combine(rules: Reading, score: float, example: str, meaning: list[str], mine: bool, agree: bool) -> Reading:
    """The rules' reading, checked against the closest labelled example (`mine`: one the person decided)."""
    like = f"reads like {_quote(example)}"
    if rules.doubt in ("dnc_reason", "mixed"):
        return rules  # only the person can settle these
    if rules.sure:
        # A status with two meanings is close to examples that have one of them; that is not a disagreement.
        if meaning != rules.outcomes and not (meaning and set(meaning) <= set(rules.outcomes)) and score >= DISAGREE:
            extra = ["do_not_call"] if "do_not_call" in meaning and not set(rules.outcomes) & set(NEGATIVE) else []
            return Reading(sort_outcomes(rules.outcomes + extra), False, "rules+model",
                           f"The words say {_names(rules.outcomes)}, but it {like} ({_names(meaning)})", "model_disagrees")
        return Reading(rules.outcomes, True, "rules+model" if meaning == rules.outcomes and score >= AGREE else "rules", rules.why)
    if rules.doubt == "unknown_words" and rules.outcomes and meaning == rules.outcomes and score >= AGREE and agree:
        return Reading(rules.outcomes, True, "rules+model", f"Known words, and it {like}")
    if rules.doubt == "unknown" and mine:
        if score >= NEAR_COPY:
            return Reading(meaning, True, "model", f"Almost the same as {_quote(example)}, which you chose before")
        if score >= GUESS:
            return Reading(meaning, False, "model", f"A guess: it is like {_quote(example)}, which you chose before", "guess")
    return rules


def _names(outcomes: Sequence[str]) -> str:
    return " + ".join(LABELS[kind] for kind in outcomes) or "no outcome"
