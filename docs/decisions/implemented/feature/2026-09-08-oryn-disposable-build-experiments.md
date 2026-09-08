# Decision Record: Run checks in disposable build experiments

Status: implemented

## Problem

Checking the frozen worker directory read-only prevents ordinary builds from producing output. Making the entire directory writable would let a check change the source it claims to verify. Per-command scratch directories also cannot share build products through a multi-command verification plan.

## Decision

The check executor materializes the fixed commit into a fresh private Git checkout using its object store, an independent index/configuration and no candidate hooks or inherited Git configuration. It does not copy ignored or untracked files. The source worktree remains untouched. Repository objects and experiment source are read-only inside the native sandbox.

Installation profiles declare relative `writableDirectories`, limited to 32 entries. These paths cannot overlap tracked/materialized source, symlink ancestors or protected metadata. The executor shares these output directories among the commands in one plan and removes the experiment after physical execution settles. Independent runs receive independent outputs. The receipt retains the original commit/tree identity and rejects changed source or ownership as inconclusive.

Case reads expose allowed execution profiles to engineering and workers. Repository `testProfiles` filters both discovery and execution admission. QA does not receive this engineering configuration. Source-overlay plans are rejected because the executor cannot honestly claim to have applied an unspecified patch.

## Alternatives considered

**Make the frozen worktree writable and compare it afterward.** A command can change source, execute altered tests and restore the original bytes. Physical source protection must remain in place.

**Copy the entire existing working directory.** Ignored credentials, dependencies, generated files and local Git configuration would become undeclared verification inputs.

**Use per-command temporary outputs.** Build and test steps need to share artifacts within one bounded plan while remaining separate from other runs.

## Consequences

Native tests compile and execute real TypeScript through `Bun.build()`, verify exact Git identity, reject source and metadata writes and symlink escapes, exclude ignored secrets and local dependencies, retain outputs across commands, isolate separate experiments and verify cleanup. Linux CI additionally runs the Bun build CLI. macOS CLI ancestor discovery can require directory reads that this policy denies; the API build test does not claim general CLI compatibility.

There is no persistent dependency cache, artifact retention, network installation, source-overlay application or automatic orphan-directory discovery. A runtime crash can retain temporary experiments that require stopped-runtime inspection. Deployment still needs dependency provisioning and OS resource controls. New profiles are optional configuration with no persisted Case schema change; the OpenAPI/SDK and configuration reference are generated from the field definition.
