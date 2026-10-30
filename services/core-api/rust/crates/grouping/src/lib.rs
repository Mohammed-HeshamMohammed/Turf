//! Deterministic grouping of matched records (plan 2.9, step 5).
//!
//! Comparisons run elsewhere (Python reference path or the C++ batch engine) and produce pair decisions. This crate
//! assembles them into global groups the same way everywhere: on the API, in workers and in offline Skip Tracing.
//!
//! Rules, in order:
//! 1. Manual "keep apart" constraints always win: a merge that would put two kept-apart records in one group is refused
//!    and reported as a rejected bridge.
//! 2. Manual "same" constraints merge first, then automatic matches in descending score, ties by record order.
//! 3. Each group is listed in record order, groups by their first record, and the survivor is the record with the most
//!    filled fields, ties by the lowest index. Output never depends on input pair order.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pair {
    pub a: u32,
    pub b: u32,
    /// Higher merges first. Manual "same" constraints should use `f32::INFINITY`.
    pub score: f32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub members: Vec<u32>,
    pub survivor: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grouping {
    /// Only groups of two or more records.
    pub groups: Vec<Group>,
    /// Matches refused because they would join records that must stay apart.
    pub rejected: Vec<Pair>,
}

struct Sets {
    parent: Vec<u32>,
    /// For each root, the roots it may never join.
    apart: Vec<Vec<u32>>,
}

impl Sets {
    fn new(n: usize) -> Self {
        Sets { parent: (0..n as u32).collect(), apart: vec![Vec::new(); n] }
    }

    fn find(&mut self, x: u32) -> u32 {
        let mut root = x;
        while self.parent[root as usize] != root {
            root = self.parent[root as usize];
        }
        let mut node = x;
        while self.parent[node as usize] != root {
            let next = self.parent[node as usize];
            self.parent[node as usize] = root;
            node = next;
        }
        root
    }

    fn blocked(&mut self, ra: u32, rb: u32) -> bool {
        let list = self.apart[ra as usize].clone();
        list.into_iter().any(|other| self.find(other) == rb)
    }

    /// Joins two sets unless a constraint forbids it. The lower root survives, keeping results order-independent.
    fn join(&mut self, a: u32, b: u32) -> bool {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return true;
        }
        if self.blocked(ra, rb) || self.blocked(rb, ra) {
            return false;
        }
        let (keep, gone) = if ra < rb { (ra, rb) } else { (rb, ra) };
        self.parent[gone as usize] = keep;
        let moved = std::mem::take(&mut self.apart[gone as usize]);
        self.apart[keep as usize].extend(moved);
        true
    }
}

/// Groups `count` records. `filled[i]` is how many fields record `i` has, for survivor choice; missing entries count 0.
pub fn group(count: usize, matches: &[Pair], keep_apart: &[(u32, u32)], filled: &[u32]) -> Grouping {
    let mut sets = Sets::new(count);
    for &(a, b) in keep_apart {
        if (a as usize) < count && (b as usize) < count && a != b {
            sets.apart[a as usize].push(b);
            sets.apart[b as usize].push(a);
        }
    }
    let mut ordered: Vec<Pair> = matches
        .iter()
        .copied()
        .filter(|p| (p.a as usize) < count && (p.b as usize) < count && p.a != p.b && !p.score.is_nan())
        .map(|p| if p.a < p.b { p } else { Pair { a: p.b, b: p.a, score: p.score } })
        .collect();
    ordered.sort_by(|x, y| y.score.total_cmp(&x.score).then(x.a.cmp(&y.a)).then(x.b.cmp(&y.b)));
    ordered.dedup_by(|x, y| x.a == y.a && x.b == y.b);
    let mut rejected = Vec::new();
    for pair in ordered {
        if !sets.join(pair.a, pair.b) {
            rejected.push(pair);
        }
    }
    let mut by_root: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for i in 0..count as u32 {
        let root = sets.find(i);
        by_root.entry(root).or_default().push(i);
    }
    let mut groups: Vec<Group> = by_root
        .into_values()
        .filter(|members| members.len() > 1)
        .map(|members| {
            let survivor = *members
                .iter()
                .max_by(|&&x, &&y| {
                    let fx = filled.get(x as usize).copied().unwrap_or(0);
                    let fy = filled.get(y as usize).copied().unwrap_or(0);
                    fx.cmp(&fy).then(y.cmp(&x))
                })
                .expect("groups are not empty");
            Group { members, survivor }
        })
        .collect();
    groups.sort_by_key(|g| g.members[0]);
    Grouping { groups, rejected }
}

// ------------------------------------------------------------------------------------------------ native ABI
//
// Version 1 of the ABI in contracts/native/callerwhale_grouping.h. The caller owns every input buffer; output buffers are
// allocated here and released with callerwhale_grouping_free.

pub const ABI_VERSION: u32 = 1;

#[repr(C)]
pub struct CallerWhalePair {
    pub a: u32,
    pub b: u32,
    pub score: f32,
}

#[repr(C)]
pub struct CallerWhaleGrouping {
    /// For each record, the index of its group's survivor; a record outside any group points at itself.
    pub survivor_of: *mut u32,
    pub count: usize,
    pub rejected: *mut CallerWhalePair,
    pub rejected_count: usize,
}

#[no_mangle]
pub extern "C" fn callerwhale_grouping_abi_version() -> u32 {
    ABI_VERSION
}

/// # Safety
/// `matches` must point at `match_count` pairs, `apart` at `apart_count * 2` indexes, `filled` at `count` values
/// (or be null). `out` must be valid for writes. Returns 0 on success, 1 on an invalid argument.
#[no_mangle]
pub unsafe extern "C" fn callerwhale_grouping_run(
    count: usize,
    matches: *const CallerWhalePair,
    match_count: usize,
    apart: *const u32,
    apart_count: usize,
    filled: *const u32,
    out: *mut CallerWhaleGrouping,
) -> i32 {
    if out.is_null() || (match_count > 0 && matches.is_null()) || (apart_count > 0 && apart.is_null()) || count > u32::MAX as usize {
        return 1;
    }
    let pairs: Vec<Pair> = if match_count == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(matches, match_count).iter().map(|p| Pair { a: p.a, b: p.b, score: p.score }).collect()
    };
    let raw_apart = if apart_count == 0 { &[][..] } else { std::slice::from_raw_parts(apart, apart_count * 2) };
    let keep: Vec<(u32, u32)> = raw_apart.chunks_exact(2).map(|c| (c[0], c[1])).collect();
    let filled = if filled.is_null() { &[][..] } else { std::slice::from_raw_parts(filled, count) };
    let result = group(count, &pairs, &keep, filled);
    let mut survivor_of: Vec<u32> = (0..count as u32).collect();
    for g in &result.groups {
        for &m in &g.members {
            survivor_of[m as usize] = g.survivor;
        }
    }
    let mut rejected: Vec<CallerWhalePair> = result.rejected.iter().map(|p| CallerWhalePair { a: p.a, b: p.b, score: p.score }).collect();
    survivor_of.shrink_to_fit();
    rejected.shrink_to_fit();
    let (s_ptr, s_len) = (survivor_of.as_mut_ptr(), survivor_of.len());
    let (r_ptr, r_len) = (rejected.as_mut_ptr(), rejected.len());
    std::mem::forget(survivor_of);
    std::mem::forget(rejected);
    *out = CallerWhaleGrouping { survivor_of: s_ptr, count: s_len, rejected: r_ptr, rejected_count: r_len };
    0
}

/// # Safety
/// `out` must have been filled by `callerwhale_grouping_run` and not freed before.
#[no_mangle]
pub unsafe extern "C" fn callerwhale_grouping_free(out: *mut CallerWhaleGrouping) {
    if out.is_null() {
        return;
    }
    let g = &mut *out;
    if !g.survivor_of.is_null() {
        drop(Vec::from_raw_parts(g.survivor_of, g.count, g.count));
    }
    if !g.rejected.is_null() {
        drop(Vec::from_raw_parts(g.rejected, g.rejected_count, g.rejected_count));
    }
    *g = CallerWhaleGrouping { survivor_of: std::ptr::null_mut(), count: 0, rejected: std::ptr::null_mut(), rejected_count: 0 };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: u32, b: u32, score: f32) -> Pair {
        Pair { a, b, score }
    }

    #[test]
    fn groups_are_independent_of_pair_order() {
        let pairs = [p(0, 1, 0.9), p(1, 2, 0.8), p(4, 3, 0.7)];
        let mut reversed = pairs;
        reversed.reverse();
        let a = group(5, &pairs, &[], &[]);
        assert_eq!(a, group(5, &reversed, &[], &[]));
        assert_eq!(a.groups.iter().map(|g| g.members.clone()).collect::<Vec<_>>(), vec![vec![0, 1, 2], vec![3, 4]]);
    }

    #[test]
    fn keep_apart_rejects_the_bridge_but_keeps_the_stronger_match() {
        // 0~1 strongly, 1~2 weakly, but 0 and 2 are different household members.
        let result = group(3, &[p(1, 2, 0.6), p(0, 1, 0.95)], &[(0, 2)], &[]);
        assert_eq!(result.groups, vec![Group { members: vec![0, 1], survivor: 0 }]);
        assert_eq!(result.rejected, vec![p(1, 2, 0.6)]);
    }

    #[test]
    fn transitive_bridges_through_merged_sets_are_refused() {
        let result = group(4, &[p(0, 1, 0.9), p(2, 3, 0.9), p(1, 2, 0.5)], &[(0, 3)], &[]);
        assert_eq!(result.groups.len(), 2);
        assert_eq!(result.rejected, vec![p(1, 2, 0.5)]);
    }

    #[test]
    fn survivor_has_most_fields_then_lowest_index() {
        let result = group(3, &[p(0, 1, 1.0), p(1, 2, 1.0)], &[], &[2, 5, 5]);
        assert_eq!(result.groups[0].survivor, 1);
    }

    #[test]
    fn invalid_pairs_are_ignored() {
        let result = group(2, &[p(0, 0, 1.0), p(0, 9, 1.0), p(0, 1, f32::NAN)], &[], &[]);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn native_abi_round_trip() {
        let pairs = [CallerWhalePair { a: 0, b: 1, score: 0.9 }, CallerWhalePair { a: 1, b: 2, score: 0.5 }];
        let apart = [0u32, 2];
        let mut out = CallerWhaleGrouping { survivor_of: std::ptr::null_mut(), count: 0, rejected: std::ptr::null_mut(), rejected_count: 0 };
        let code = unsafe { callerwhale_grouping_run(3, pairs.as_ptr(), 2, apart.as_ptr(), 1, std::ptr::null(), &mut out) };
        assert_eq!(code, 0);
        let survivors = unsafe { std::slice::from_raw_parts(out.survivor_of, out.count) }.to_vec();
        assert_eq!(survivors, vec![0, 0, 2]);
        assert_eq!(out.rejected_count, 1);
        unsafe { callerwhale_grouping_free(&mut out) };
        assert!(out.survivor_of.is_null());
        assert_eq!(unsafe { callerwhale_grouping_run(1, std::ptr::null(), 1, std::ptr::null(), 0, std::ptr::null(), &mut out) }, 1);
    }
}
