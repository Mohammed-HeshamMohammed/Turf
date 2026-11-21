/* Caller Whale grouping ABI, version 1 (backend/rust/crates/grouping). Plan 2.3 "Native matching ABI".
 * Memory: the caller owns every input buffer. callerwhale_grouping_run allocates the output buffers;
 * release them with callerwhale_grouping_free exactly once. Functions never retain caller pointers. */
#ifndef CALLERWHALE_GROUPING_H
#define CALLERWHALE_GROUPING_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct { uint32_t a; uint32_t b; float score; } CallerWhalePair;

typedef struct {
  uint32_t *survivor_of; /* count entries: the survivor index of each record's group (itself when ungrouped) */
  size_t count;
  CallerWhalePair *rejected;    /* matches refused because they would join records that must stay apart */
  size_t rejected_count;
} CallerWhaleGrouping;

uint32_t callerwhale_grouping_abi_version(void); /* 1 */

/* Returns 0 on success, 1 on an invalid argument. apart holds apart_count pairs of indexes (2 * apart_count values).
 * filled may be NULL; otherwise count values used to choose survivors (most filled fields, then lowest index). */
int32_t callerwhale_grouping_run(size_t count, const CallerWhalePair *matches, size_t match_count,
                          const uint32_t *apart, size_t apart_count, const uint32_t *filled, CallerWhaleGrouping *out);

void callerwhale_grouping_free(CallerWhaleGrouping *out);

#ifdef __cplusplus
}
#endif
#endif
