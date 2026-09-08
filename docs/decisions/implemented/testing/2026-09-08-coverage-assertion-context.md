# Decision Record: Preserve assertion context in coverage summaries

Status: implemented

## Problem

A failed coverage batch can exceed the gate's retained head/tail output. A failing test name alone cannot distinguish a data mismatch from setup, timing or infrastructure failure. Colored Bun diagnostics and blank lines can prevent the separate error-line extractor from retaining the assertion details.

## Decision

Coverage failure summaries normalize ANSI styling and retain bounded context immediately preceding each selected failing test. The context includes assertion values and stack locations across blank lines, stops at the preceding test/group boundary and respects the existing failing-test count cap. Per-test context is limited to 40 lines and 6000 characters. The gate still fails on the same underlying command result and does not alter coverage thresholds or test selection.

## Alternatives considered

**Increase the retained whole-log prefix.** The failure may occur anywhere in a large shard, so a larger prefix cannot reliably preserve it.

**Treat a passing isolated rerun as resolving the CI failure.** It does not explain a failure caused by instrumentation, shard interaction or timing. Preserve actionable evidence for the next reproduction instead.

## Consequences

Tests verify colored assertion output, blank-line-separated expected/received values, stack locations, exclusion of neighboring test output and the existing failing-test cap. More diagnostic context appears in CI errors. The Boss worker-status coverage failure that motivated this change remains an independent investigation; improved diagnostics do not claim to fix it.
