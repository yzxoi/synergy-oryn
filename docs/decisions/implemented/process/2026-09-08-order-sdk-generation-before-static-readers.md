# Decision Record: Order SDK generation before static readers

Status: implemented

## Problem

The local static cluster ran SDK package generation concurrently with format, type and dependency checks. The generator cleans its output directory before rewriting it, so readers could observe missing or unformatted files. Reusing formatter cache entries during repeated clean generation also left raw generated files unchanged during the observed validation runs.

## Decision

Format, type and dependency checks depend on package validation in the shared gate graph. A dependency is satisfied only when its execution settles, not when it leaves the pending set to start running. Other independent gates retain their existing concurrency. SDK generation always formats its output without the shared formatter cache; generation must produce formatted files regardless of earlier check runs.

## Alternatives considered

**Ignore generated clients in static checks.** This hides client syntax, type and formatting failures. Ordering retains the checks and removes the competing writer.

**Run the whole cluster serially.** This prevents the race but also delays unrelated checks. The graph records only the necessary dependencies.

## Consequences

A scheduling test exercises the local and CI static graphs with delayed package generation and asserts that SDK readers cannot start early. Repeated full generation and output hashes verify stable files. This change does not address Knip resolving the wrong outer configuration in a nested checkout; that condition requires a separate loader fix or equivalent invocation from the package directory.
