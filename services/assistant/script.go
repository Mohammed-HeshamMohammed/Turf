package main

// The scripted half of the assistant: answers that are written down, so common questions cost nothing, are always the same, and
// can never promise what Caller Whale does not offer. Anything it cannot answer goes to the AI (ai.go), whose instructions carry
// the same facts. Prices are drafts: no number is stated here, the pricing page builds the real total.

import (
	"regexp"
	"strings"
)

type link struct {
	Label string `json:"label"`
	To    string `json:"to"`
}

type answer struct {
	Reply       string   `json:"reply"`
	Suggestions []string `json:"suggestions,omitempty"`
	Link        *link    `json:"link,omitempty"`
}

const (
	askTeamSize = "How many people will be making calls?"
	startPlans  = "Which plan fits me?"
)

var (
	toPricing = &link{"See pricing", "/pricing"}
	toSignup  = &link{"Start the free trial", "/signup"}
)

// facts is what the AI is told about Caller Whale. It is the only product knowledge it has.
const facts = `Caller Whale is a calling workspace for people who work property leads (wholesalers, small agencies, call teams).
It keeps lists, lead records, calls, handoffs and reports together. Parts: importing lists (CSV and spreadsheets, original values kept),
skip tracing (phone evidence checks, Do Not Call), a dialer with texting, a leads map, the CRM (leads, tasks, notes, deals, handoffs),
AI campaigns (emails and texts), and exports with backup and restore. The desktop app is for Windows first; there is also a web CRM.
Plans: Free trial (anyone, 7 days, small limits); Solo (1 person); Duo (exactly 2 people, both see everything); Team (3 or more people,
roles for owners, team leads, callers, closers and researchers, assignments and reports); Pro (teams that work leads all day: multi-line
dialing, number health checks, custom roles and API access, scheduled reports, higher limits, longer recycle bin and audit log).
Each feature is priced on its own and a plan is the sum of the features switched on; clients and partners you share properties with are free seats.
All prices are drafts and can change: never state a price; send people to the pricing page, where they build their own total.
Accounts are for people aged 18 or older. Sign-in supports two-step verification. The security page lists what is protected and what is still in preview.`

var proAnswer = answer{Reply: "Pro is for teams that work leads all day: multi-line dialing with voicemail drop, number health checks, custom roles and API access, scheduled reports and higher limits. It is priced per seat, and the pricing page shows the draft total for your team.",
	Suggestions: []string{"Start the free trial", "See pricing"}, Link: toPricing}

type topic struct {
	id    string
	words []string
	ans   answer
}

var topics = []topic{
	{"plans", []string{"which plan", "what plan", "membership", "which membership", "plan fits", "plans", "tier", "solo", "duo", "which one should"},
		answer{Reply: "Happy to point you to the right one. " + askTeamSize, Suggestions: []string{"Just me", "Two of us", "3 to 10 people", "More than 10"}}},
	{"price", []string{"price", "pricing", "cost", "how much", "pay", "billing", "expensive", "cheap", "per month", "monthly", "subscription"},
		answer{Reply: "Each feature is priced on its own, and a plan is the sum of the ones you switch on, so you only pay for what you use. The numbers on the site are drafts and may change, so build your own total on the pricing page rather than relying on me.",
			Suggestions: []string{startPlans, "Is there a free trial?"}, Link: toPricing}},
	{"trial", []string{"free trial", "trial", "free", "try it", "try for free", "demo"},
		answer{Reply: "Yes. The free trial lasts 7 days and lets you try everything at small limits. You only need an account, and you must be 18 or older.",
			Suggestions: []string{startPlans, "What can I import?"}, Link: toSignup}},
	{"what", []string{"what is caller whale", "what does caller whale do", "what do you do", "what does it do", "what is this", "about", "overview", "who is it for"},
		answer{Reply: "Caller Whale keeps your lists, lead records, calls, handoffs and reports in one workspace, built for people who work property leads: import a list, check the phones, call, record the outcome, and hand deals to the right teammate.",
			Suggestions: []string{startPlans, "How do I import a list?", "Is it secure?"}, Link: &link{"See the features", "/features"}}},
	{"import", []string{"import", "upload", "csv", "spreadsheet", "excel", "xlsx", "list", "column", "mapping"},
		answer{Reply: "You can bring in CSV and spreadsheet lists. Caller Whale matches your columns to its fields, keeps your original values untouched, removes identical rows, and shows you rows that repeat before anything is added. In the web CRM, big lists are sent in pieces and read on the server, so a dropped connection does not lose your place.",
			Suggestions: []string{"What about skip tracing?", startPlans}, Link: &link{"About importing lists", "/features"}}},
	{"calls", []string{"call", "dialer", "dial", "calling", "sms", "text", "texting", "voicemail", "phone"},
		answer{Reply: "The dialer works your queue, records each outcome (voicemail, callback, not interested, wrong number and so on) and sets the next try for you. Texting sits beside it. Calling and syncing need an internet connection.",
			Suggestions: []string{"Does it work offline?", startPlans}, Link: &link{"About the dialer", "/features"}}},
	{"offline", []string{"offline", "without internet", "no internet", "connection"},
		answer{Reply: "Opening a list, skip tracing it and exporting run on your own computer. Signing in, syncing with your team, calling and messaging need a connection.",
			Suggestions: []string{"Where are my records kept?"}}},
	{"security", []string{"secure", "security", "safe", "privacy", "data", "two-step", "2fa", "encrypted", "gdpr", "records kept"},
		answer{Reply: "Accounts support two-step sign-in, and each workspace can only see its own records. The security page says plainly what is protected today and what is still in preview.",
			Suggestions: []string{"How do I contact you?"}, Link: &link{"Read about security", "/security"}}},
	{"team", []string{"team", "agency", "employees", "roles", "manager", "closer", "caller", "researcher", "seats", "people"},
		answer{Reply: "Team plans give each person a role (owner, team lead, caller, closer, researcher) with their own view, plus assignments, handoffs and reports. Clients and partners you share properties with are free seats.",
			Suggestions: []string{startPlans}, Link: toPricing}},
	{"windows", []string{"download", "install", "windows", "mac", "app", "desktop", "linux", "android", "iphone"},
		answer{Reply: "The desktop app is for Windows first, and there is a web CRM too. Create an account to follow the launch; the download appears in your dashboard when it is ready.",
			Suggestions: []string{"Is there a free trial?"}, Link: &link{"Create an account", "/signup"}}},
	{"signup", []string{"sign up", "signup", "create account", "register", "join", "get started", "start"},
		answer{Reply: "Creating an account takes about a minute: your name, email and a password (or Google), then your date of birth, because Caller Whale is for people 18 or older. Then you confirm your email.",
			Suggestions: []string{"I forgot my password", "Is there a free trial?"}, Link: &link{"Create an account", "/signup"}}},
	{"signin", []string{"sign in", "signin", "log in", "login", "password", "forgot", "locked", "reset"},
		answer{Reply: "On the sign-in page you can use your email and password or Google. If you forgot your password, the reset link on that page emails you a new one. If your account uses two-step sign-in, you will be asked for the code after your password.",
			Link: &link{"Reset my password", "/forgot"}}},
	{"contact", []string{"contact", "support", "human", "person", "talk to someone", "email you", "help me", "speak"},
		answer{Reply: "You can message the team from the contact page and a person will answer. I am an automated assistant, so for anything about your account or billing, the team is the right place.",
			Link: &link{"Contact the team", "/contact"}}},
	{"skip", []string{"skip tracing", "skip trace", "skiptrace", "phone check", "do not call", "dnc"},
		answer{Reply: "Skip tracing checks the phone evidence in your list (which numbers look usable, and which are on Do Not Call) before you spend time dialing. It runs on your own computer, and your original values stay available for review. Caller Whale helps you check; you remain responsible for following the calling rules where you work.",
			Suggestions: []string{"How do I import a list?", startPlans}, Link: &link{"About skip tracing", "/features"}}},
	{"pro", []string{"what is in pro", "pro plan", "pro features", "power features"}, proAnswer},
	{"hello", []string{"hello", "hi", "hey", "good morning", "good evening", "help"},
		answer{Reply: "Hi, I'm the Caller Whale assistant. I'm automated, and I can help you find the right plan, explain what Caller Whale does, or get you started. What would you like to know?",
			Suggestions: []string{startPlans, "What does Caller Whale do?", "Is there a free trial?"}}},
}

var tokenPattern = regexp.MustCompile(`[a-z0-9#']+`)

// match returns the topic a short message is clearly about, scored by how many of its phrases appear. ok is false when nothing fits.
func match(text string) (topic, int) {
	lower := strings.ToLower(text)
	words := " " + strings.Join(tokenPattern.FindAllString(lower, -1), " ") + " "
	best, score := topic{}, 0
	for _, t := range topics {
		n := 0
		for _, w := range t.words {
			if strings.Contains(words, " "+strings.Join(tokenPattern.FindAllString(w, -1), " ")+" ") {
				n += 1 + strings.Count(w, " ")
			}
		}
		if n > score {
			best, score = t, n
		}
	}
	return best, score
}

// advise turns "how many people" into a plan. It runs when the last thing the assistant asked was the team-size question.
func advise(reply string) (answer, bool) {
	tokens := tokenPattern.FindAllString(strings.ToLower(reply), -1)
	has := func(words ...string) bool {
		for _, t := range tokens {
			for _, w := range words {
				if t == w {
					return true
				}
			}
		}
		return false
	}
	n := 0
	for _, t := range tokens {
		n = max(n, atoi(t))
	}
	switch {
	case has("pro", "power"):
		return proAnswer, true
	case has("me", "myself", "solo", "alone") || n == 1:
		return answer{Reply: "Solo fits you: one person doing everything, from lists and skip tracing to calls and deals. You can try everything free for 7 days first.",
			Suggestions: []string{"Start the free trial", "See pricing"}, Link: toSignup}, true
	case has("two", "both", "couple", "partner") || n == 2:
		return answer{Reply: "Duo fits two partners, or a caller and a closer: both of you see everything, with nothing to set up. You can try it free for 7 days first.",
			Suggestions: []string{"Start the free trial", "See pricing"}, Link: toSignup}, true
	case n >= 3 || has("team", "more", "lots", "many"):
		return answer{Reply: "Team fits three or more people: each person gets a role (owner, team lead, caller, closer, researcher), with assignments, handoffs and reports. If your callers work leads all day and need multi-line dialing, custom roles or API access, look at Pro as well.",
			Suggestions: []string{"I need power features (Pro)", "Start the free trial", "See pricing"}, Link: toPricing}, true
	}
	return answer{}, false
}

func atoi(s string) int {
	n := 0
	if len(s) > 6 {
		return 0
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// fallback is what a person gets when nothing fits and the AI is off or unavailable.
var fallback = answer{
	Reply:       "I am not sure I have that right, and I would rather not guess. The team can answer it properly, or I can help with plans, features and getting started.",
	Suggestions: []string{startPlans, "What does Caller Whale do?"},
	Link:        &link{"Contact the team", "/contact"},
}

// scripted answers from what has been written down. ok is false when the question is better left to the AI (or the fallback).
func scripted(history []message) (answer, bool) {
	last := history[len(history)-1].Content
	if len(history) >= 2 {
		prev := history[len(history)-2]
		if prev.Role == "assistant" && strings.Contains(prev.Content, askTeamSize) {
			if a, ok := advise(last); ok {
				return a, true
			}
		}
	}
	short := len(tokenPattern.FindAllString(last, -1)) <= 9
	if t, score := match(last); score > 0 && short {
		return t.ans, true
	}
	return answer{}, false
}
