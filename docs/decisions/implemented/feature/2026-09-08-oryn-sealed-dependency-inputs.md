# Decision Record: Seal dependency inputs for isolated checks

Status: implemented

## Problem

A fixed-commit experiment excludes ignored local dependencies. Many builds therefore cannot run, while borrowing a worker's live dependency directory would admit mutable undeclared inputs and cross-Case changes. Network installation inside checks would add credentials, lifecycle scripts and environmental variability to the evidence path.

## Decision

An operator seals preinstalled dependencies from a reviewed clean Bun checkout using `synergy oryn seal-dependencies`. The command writes a new installation-owned directory containing a version-1 manifest and content-addressed blobs. An execution profile pins its manifest digest. The format records platform, architecture, exact Bun version and tracked dependency inputs, including declared patch files. It does not claim installation-script provenance or completeness.

The executor selects exactly one matching snapshot, verifies each copied blob and materializes independent read-only dependencies in each disposable experiment. Relative workspace links bind to the experiment source; lexical and final resolved paths cannot escape or enter protected metadata. No link is followed while materializing files. Dependency roots cannot overlap tracked source or become writable output directories. Missing, corrupt, incompatible and ambiguous snapshots fail before check execution. Optional profiles without snapshots still support dependency-free checks.

Engineering profile discovery exposes digests without installation paths. Successful run observations identify the selected digest. Snapshot selection and materialization are Host operations, not model tools or new jobs. Canonical Case storage is unchanged; unsupported external manifest versions are rejected.

## Alternatives considered

**Borrow an existing node_modules directory.** It can change between runs, expose unrelated local files and share writable state across Cases.

**Install packages in every check.** This requires network and lifecycle-script execution in the evidence sandbox and makes baseline/candidate environments depend on remote services.

**Bind every snapshot to the whole commit.** This invalidates unchanged dependencies for ordinary source fixes. Dependency input matching permits reuse; workspace links rebind to the frozen source. Copied local file/link dependencies are rejected because their source content needs additional fingerprinting.

## Consequences

Tests exercise the real CLI, native containment, digest corruption, input changes, chained symlink escapes, no-overwrite output, workspace rebinding and independent materialization. Linux CI builds an application with sealed registry and workspace dependencies. macOS bare-package discovery can request forbidden ancestor-directory reads and remains an explicit platform limitation, without broadening host access.

Copying dependencies increases disk use and preparation latency. Limits bound file, total and manifest sizes and entry counts; automatic retention, garbage collection and crash-orphan recovery are not implemented. Runtime/OS library versions, installation script inputs and complete execution-policy snapshots remain outside this format. Operators must provision dependencies with reviewed commands, protect snapshot ownership and validate their actual project before deployment acceptance. See the [deployment procedure](../../../operations/oryn-deployment.md#sealed-dependency-inputs).
