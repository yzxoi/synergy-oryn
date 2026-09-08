# Decision Record: Select installation-owned embedding for Oryn memory

Status: implemented

## Problem

Oryn memory insertion called the ordinary Scope-based embedding path. Background recovery without a Scope failed configuration lookup, while execution with a candidate Scope could use that project's embedding endpoint and credentials. Merely changing configuration lookup would still allow reuse of a local extractor initialized by a candidate project.

## Decision

The shared embedding module exposes an installation-owned generation path that reads global domain configuration directly. Oryn's Library adapter selects that path. It preserves the existing generation, timeout, cancellation, provider pricing and rollout recording implementation, and supports both configured remote embedding and the bundled local model without requiring a project Scope.

Ordinary Scope-based calls and installation calls each own a local extractor, initialization state and lifecycle generation. They do not reuse one another's initialized extractor. Transformers uses module-global download settings, so local loading and cache inspection serialize configuration through initialization. Completed extractors remain independently usable. Disposal resets and releases both owners, including through the existing global embedding reload and runtime shutdown hooks.

## Alternatives considered

**Supply a home Scope around the original call.** That could select global configuration but would not prevent reuse of a project-initialized local extractor.

**Duplicate the embedding API client in Oryn.** That would split timeout, telemetry, pricing and local-model behavior from their shared implementation.

**Require a remote embedding API.** The existing product also supports its bundled local model; installation ownership should apply to both modes.

## Consequences

Tests exercise real global/project configuration and loopback embedding endpoints, reject candidate endpoint selection, and insert a real Library row without an ambient Scope. A controlled local runtime proves independent extractor selection in both directions and releases both instances on disposal. Existing local initialization, fallback, progress, retry and disposal tests remain applicable.

Two initialized local owners can hold two model instances. On-disk assets still use their configured cache directories; separate in-memory ownership does not attest the provenance of files already in that cache. This change establishes configuration selection and lifecycle ownership, not semantic lesson validation, sanitization of lesson text or correctness of a third-party embedding service. Automatic verified memory remains opt-in.
