//! The public contract (contracts/api-v1.yaml) and the router must list the same routes (plan 1: CI contract checks).

use std::collections::BTreeSet;

fn contract_paths() -> BTreeSet<String> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../contracts/api-v1.yaml")).expect("contracts/api-v1.yaml");
    let mut in_paths = false;
    let mut paths = BTreeSet::new();
    for line in text.lines() {
        if line.starts_with("paths:") {
            in_paths = true;
            continue;
        }
        if in_paths {
            if let Some(rest) = line.strip_prefix("  /") {
                paths.insert(format!("/{}", rest.split(':').next().unwrap().trim()));
            }
        }
    }
    paths
}

fn router_paths() -> BTreeSet<String> {
    let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src/routes");
    let mut paths = BTreeSet::new();
    for (file, prefix) in [
        ("mod.rs", ""),
        ("identity.rs", "/api/v1"),
        ("admin.rs", "/api/v1"),
        ("records.rs", "/api/v1"),
        ("reports.rs", "/api/v1"),
        ("artifacts.rs", "/api/v1"),
        ("internal.rs", "/internal"),
        ("worker_data.rs", "/internal"),
    ] {
        let text = std::fs::read_to_string(format!("{src}/{file}")).unwrap();
        for piece in text.split(".route(\"").skip(1) {
            let path = piece.split('"').next().unwrap();
            paths.insert(format!("{prefix}{path}"));
        }
    }
    paths
}

#[test]
fn every_route_is_in_the_contract_and_back() {
    let contract = contract_paths();
    let router = router_paths();
    let missing: Vec<_> = router.difference(&contract).collect();
    let stale: Vec<_> = contract.difference(&router).collect();
    assert!(missing.is_empty() && stale.is_empty(), "not in contract: {missing:?}; not in router: {stale:?}");
}
