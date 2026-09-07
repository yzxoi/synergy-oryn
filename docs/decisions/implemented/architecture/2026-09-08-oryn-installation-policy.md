# Decision Record: Oryn installation policy and reserved agents

Status: implemented

## Problem

Oryn authorizes repositories, execution profiles, publication and repair budgets from its configuration. Reading `Config.current()` inside a repository Scope allowed that repository's configuration to enable or disable Oryn and replace these choices. Ordinary agent overrides could also rename a reviewer before its permission ceiling was applied, replace its prompt, or select full access. Candidate repository contents cannot grant these authorities.

## Decision

`OrynConfig.info()` reads `Config.globalRaw()`, the installation-owned domain configuration. Every Oryn business consumer continues to use that accessor. The `oryn` section of project, explicit or inline scoped configuration is not an authorization source. The existing configuration resolver still exposes ordinary project configuration for ordinary Synergy behavior; Oryn does not change that merge globally.

The agent factory uses installation configuration to enable Oryn and select its model roles. The five Oryn agent IDs are reserved: config entries, config aliases, plugin contributions and external-agent discovery cannot create or replace them, including while Oryn is disabled. Built-in prompts, mode, visibility and identity remain host-owned. Model selection uses the installation's existing model-role fields; arbitrary per-agent Oryn definition overrides are not supported.

The installation policy accessor is uncached beyond the Config owner's cache. A successful global domain update therefore changes the next business authorization read without replacing the project Scope. This does not add a startup/reload recovery hook or claim immediate cancellation of already dispatched external requests. Agent catalog invalidation remains owned by the existing Agent/runtime reload path.

Oryn test fixtures write and restore real domain configuration under the preloader's isolated test home. Project fixture configuration is kept separate. Scoped test callbacks are awaited before asynchronous fixture disposal, and the Feishu ingress and engineering-start fixtures no longer replace `Config.current()`.

No persisted Oryn record format changes. Operators who previously placed Oryn authorization in a candidate repository must configure the installation explicitly; the runtime does not promote untrusted project policy into trusted configuration automatically.

## Alternatives considered

**Keep scoped configuration and clamp only publication.** Execution profiles, intake routes, budgets and agent identity would still be project-controlled. The installation accessor covers the common policy source instead of duplicating partial checks.

**Resolve the home Scope and use all effective overrides.** Oryn needs an installation-owned authorization source. Reading the domain owner's global configuration makes the source explicit and avoids treating scoped override mechanisms as operator authorization.

**Allow agent overrides and repair the permission list afterward.** A renamed agent could evade a name-based ceiling, and permission repair does not restore prompt, model role or execution identity. Reserving the built-in IDs preserves those identities before merge and discovery.

## Verification

`test/oryn/config.test.ts` covers project enable/disable attempts, repository and budget replacement, agent identity/profile/prompt replacement, alias creation, plugin/external collisions, installation model roles and global policy updates. The Oryn suite exercises real installation-domain fixtures through intake, engineering startup, dispatch, reports, review, publication transport mocks and explicit Feishu delivery. Adjacent Agent and Boss suites cover ordinary registration and workflow behavior.

## Consequences

This removes project control of Oryn business policy and built-in definitions. It does not prove that all candidate execution is contained: model/provider runtime resolution, executable project configuration, filesystem/process isolation, trusted run receipts and resource admission require their own execution-path checks. GitHub lifecycle integration, complete scripted-model mock acceptance and target-host deployment verification remain separate work.
