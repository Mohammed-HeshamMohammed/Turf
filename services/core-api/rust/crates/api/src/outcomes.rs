//! Call outcomes: the ReadyMode set the CRM records, and what each does to the lead.
//! Meanings follow Caller Whale's status reader (service/callerwhale_matching/status_meaning.py).

pub struct Outcome {
    pub label: &'static str,
    pub code: &'static str,
    pub meaning: &'static str,
    /// Days until the dialer tries again; None for no next try (or a time the person chose).
    pub recall_days: Option<i64>,
}

pub const OUTCOMES: &[Outcome] = &[
    Outcome { label: "Transfer", code: "Trans", meaning: "reached", recall_days: None },
    Outcome { label: "Callback", code: "CB", meaning: "reached", recall_days: None },
    Outcome { label: "Not interested", code: "NI", meaning: "reached", recall_days: Some(90) },
    Outcome { label: "Language barrier", code: "Lang", meaning: "reached", recall_days: None },
    Outcome { label: "Reached", code: "R", meaning: "reached", recall_days: None },
    Outcome { label: "Voicemail", code: "VM", meaning: "voicemail", recall_days: Some(1) },
    Outcome { label: "Not available", code: "NA", meaning: "no_answer", recall_days: Some(1) },
    Outcome { label: "No answer", code: "NoA", meaning: "no_answer", recall_days: Some(1) },
    Outcome { label: "Dead call", code: "Dead", meaning: "no_answer", recall_days: Some(1) },
    Outcome { label: "Wrong number", code: "W#", meaning: "wrong_number", recall_days: None },
    Outcome { label: "Wrong person", code: "WP", meaning: "wrong_person", recall_days: None },
    Outcome { label: "Disconnected", code: "Disc", meaning: "disconnected", recall_days: None },
    Outcome { label: "Do not call", code: "DNC", meaning: "do_not_call", recall_days: None },
];

pub fn find(label: &str) -> Option<&'static Outcome> {
    let wanted = label.trim().to_lowercase();
    OUTCOMES.iter().find(|o| o.label.to_lowercase() == wanted || o.code.to_lowercase() == wanted)
}
