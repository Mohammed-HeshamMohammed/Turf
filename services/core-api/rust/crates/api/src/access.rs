//! Capabilities plus record scope (plan 2.4, 3.1).

use std::collections::BTreeSet;

pub const CAPABILITIES: &[&str] = &[
    "edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "admin", "review", "publicComment",
];

/// Role presets: (key, name, capabilities, scope, requires MFA).
pub const PRESETS: &[(&str, &str, &[&str], &str, bool)] = &[
    ("solo", "Solo operator", &["edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "admin", "review"], "organization", true),
    ("researcher", "Data researcher", &["import", "export", "review"], "project", false),
    ("caller", "Caller", &["edit", "handoff", "call", "message"], "own", false),
    ("closer", "Acquisitions / closer", &["edit", "accept", "call", "message", "finance"], "own", false),
    ("manager", "Team manager", &["edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "rules"], "team", false),
    // The person who opened the workspace, and the only one who manages access in it. Nobody can be given this role,
    // and customers' workspaces have no "System administrator": that is Caller Whale's own staff (users.platform_role).
    ("owner", "Business owner", &["edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "review", "admin"], "organization", true),
    ("client", "Client / partner", &["publicComment"], "shared", false),
];

/// Roles that belong to whoever opened the workspace: never given by an invitation or a role change.
pub const HELD_ROLES: &[&str] = &["owner", "solo"];

pub fn requires_mfa(role: &str) -> bool {
    PRESETS.iter().any(|(key, _, _, _, mfa)| *key == role && *mfa)
}

#[derive(Clone, Debug, Default)]
pub struct Access {
    pub capabilities: BTreeSet<String>,
    pub scopes: BTreeSet<String>,
}

impl Access {
    /// Combines several roles' grants; explicit restrictions override them.
    pub fn combine<'a>(roles: impl IntoIterator<Item = (&'a [String], &'a str)>, restrictions: &[String]) -> Access {
        let mut access = Access::default();
        for (capabilities, scope) in roles {
            access.capabilities.extend(capabilities.iter().cloned());
            if scope != "none" {
                access.scopes.insert(scope.to_string());
            }
        }
        for restriction in restrictions {
            access.capabilities.remove(restriction);
            if let Some(scope) = restriction.strip_prefix("scope:") {
                access.scopes.remove(scope);
            }
        }
        access
    }

    pub fn can(&self, capability: &str) -> bool {
        self.capabilities.contains(capability)
    }

    pub fn sees_all(&self) -> bool {
        self.scopes.contains("organization")
    }

    /// The scope list as the comma-separated value turf_visible() reads.
    pub fn scope_setting(&self) -> String {
        self.scopes.iter().cloned().collect::<Vec<_>>().join(",")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn restrictions_override_combined_grants() {
        let caller = v(&["edit", "call"]);
        let closer = v(&["finance", "call"]);
        let access = Access::combine([(&caller[..], "own"), (&closer[..], "team")], &v(&["call", "scope:team"]));
        assert!(access.can("edit") && access.can("finance") && !access.can("call"));
        assert_eq!(access.scope_setting(), "own");
    }

    #[test]
    fn admin_alone_sees_no_records() {
        let admin = v(&["admin"]);
        let access = Access::combine([(&admin[..], "none")], &[]);
        assert!(access.scopes.is_empty() && access.can("admin"));
    }
}
