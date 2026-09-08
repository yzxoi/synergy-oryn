# Decision Record: Preserve the test shard logging destination

Status: implemented

## Problem

The LSP client suite selected stderr for the process-global logger in each test and left that destination active for subsequent files. When the migration terminal suite ran later in the same CI or coverage shard, an ordinary migration diagnostic entered its terminal capture and failed the assertion that silent rendering writes no output. Running either file alone did not expose the interaction.

## Decision

LSP interoperability tests use the isolated file logger established by the package preload. They do not select a different logger destination because their assertions concern JSON-RPC behavior, not logging. The migration suite retains its exact silent-output assertion. Verification runs the LSP client and migration terminal suites together in one Bun process, matching the ordering that reproduced the CI failure.

## Alternatives considered

**Filter log lines out of the silent-output assertion.** This would hide the leaked global state and weaken the migration output check.

**Place the suites in separate shards.** Test placement would conceal an unnecessary process-global mutation and add isolation cost to ordinary deterministic tests.

**Reinitialize logging after every LSP test.** The suite does not need console logging, so removing the override avoids extra writer and archive lifecycle work.

## Consequences

The existing JSON-RPC assertions and migration terminal assertions remain unchanged. LSP test diagnostics remain available through the normal isolated test logger. This test-only change does not alter production LSP logging, migration behavior or the CI shard planner.
