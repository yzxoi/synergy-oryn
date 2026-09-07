# Decision Record: Callable Oryn tools with role-scoped reads

Status: implemented

## Problem

The Oryn service tests bypass model tool collection. Four action tools exposed a top-level Zod discriminated union, which the production provider transformation rejects because function parameters must be an object. Direct tool reads also lacked the enable check and permitted workers to access sibling cases through a shared reporter source; report lookup accepted an arbitrary known report ID.

## Decision

`oryn_case`, `oryn_dispatch`, `oryn_result`, and `oryn_check` expose their discriminated action under an `input` object property. The variants keep their precise schemas and the normal Tool.define parser validates the nested input. Oryn role prompts document the wrapper. A behavioral test converts every registered Oryn tool through the same ProviderTransform.schema path used by SessionToolResolver, without calling a model API.

Every Oryn tool execution checks that the runtime is enabled, including reads that do not call a service method. Case reads and report reads validate a recognized binding and source membership. Worker and engineering bindings are additionally restricted to their one assigned Case; list returns only that Case. Only QA can amend reporter acceptance. Workers report blockers to the engineering root instead of taking over Case control directly.

## Alternatives considered

**Allow union roots in the generic provider transformer.** This would change the shared provider compatibility contract for every tool. Wrapping the Oryn variants is the supported local correction.

**Flatten all action fields into optional properties.** This removes the schema's action-specific required fields and makes invalid combinations easier for models to submit.

**Rely on the prompt and tool whitelist.** Tool visibility alone cannot distinguish actions, sibling Cases, or a runtime disabled after the Session was created. Host checks apply when each action executes.

## Consequences

Model callers use `{ "input": { "action": "get", "caseId": "…" } }` for case operations and the equivalent wrapper for dispatch/check. Result operations discriminate on `input.kind`. Other Oryn tools retain their object parameters. Tests exercise disabled bindings, cross-Case reads, worker attempts to change acceptance, and the callable schemas; this does not substitute for the Channel and model-execution integration tests.
