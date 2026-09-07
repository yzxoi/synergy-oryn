# Decision Record: Filter absent optional Linux runtime mounts

Status: implemented

## Problem

The helper-backed Linux default policy copied shared runtime read roots directly into required Bubblewrap mounts. These defaults include optional user caches and macOS system directories which need not exist on a Linux host. The generic sandbox execution tests failed once CI installed and exercised the helper instead of skipping it; Oryn's explicit-profile tests did not cover this default-policy path.

## Decision

Existence-filter the optional default runtime read roots when building the default Linux helper profile. Keep the workspace, explicit runtime roots, caller-provided extra roots and explicit permission profiles unchanged. An absent explicitly required path must still fail execution instead of being silently removed. This narrows optional filesystem access and does not change fallback or namespace policy.

## Alternatives considered

**Create every default directory on the host.** This mutates the host to fit a cross-platform list and creates meaningless macOS paths on Linux.

**Filter all missing paths in the Rust helper.** That would silently weaken explicitly required profiles and hide missing execution dependencies.

## Consequences

Behavioral tests inspect the generated helper input and cover both optional-root filtering and preservation of a missing explicit root. The Ubuntu 22.04/24.04 native matrix also runs the generic sandbox backend and multi-root tests. Native assertion failures include stderr to distinguish setup errors from candidate command failures. This record does not claim a native run passed until its workflow completes.
