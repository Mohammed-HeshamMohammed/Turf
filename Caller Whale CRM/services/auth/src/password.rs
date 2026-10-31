//! Account-password policy. Only validate new passwords, never login attempts.
use crate::error::{AuthError, AuthResult};

pub(super) fn validate(value: &str) -> AuthResult<()> {
    let mut missing = Vec::new();
    let length = value.chars().count();
    if !(8..=4096).contains(&length) { missing.push("8–4096 characters"); }
    if !value.chars().any(|c| c.is_ascii_uppercase()) { missing.push("an uppercase letter (A–Z)"); }
    if !value.chars().any(|c| c.is_ascii_lowercase()) { missing.push("a lowercase letter (a–z)"); }
    if !value.chars().any(|c| c.is_ascii_digit()) { missing.push("a number (0–9)"); }
    if !value.chars().any(|c| "^$*.[]{}()?\"!@#%&/\\,><':;|_~`=+-".contains(c)) { missing.push("a special character, such as !, @ or #"); }
    if missing.is_empty() { Ok(()) } else { Err(AuthError::Bad(format!("Password needs {}.", missing.join(", ")))) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundaries_and_each_requirement() {
        assert!(validate("Aa1!aaaa").is_ok());
        assert!(validate(&format!("Aa1!{}", "a".repeat(4092))).is_ok());
        for bad in ["Aa1!aaa".to_owned(), format!("Aa1!{}", "a".repeat(4093)), "aa1!aaaa".into(), "AA1!AAAA".into(), "Aa!!aaaa".into(), "Aa11aaaa".into(), "Aa11    ".into()] {
            assert!(validate(&bad).is_err());
        }
    }
}
