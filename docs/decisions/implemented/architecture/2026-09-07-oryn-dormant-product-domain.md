# Decision Record: Oryn dormant product domain

Status: implemented

## Problem

Synergy Oryn needs a first-party product domain for the feedback-to-PR automation (case intake, evidence, controlled GitHub publishing), but the target repository must remain a faithful Synergy checkout for every installation that has not opted in. Adding the domain could not be allowed to change agent catalogs, channel routing, or tool availability before an operator explicitly enables it, and the config key needed a canonical owning domain so the generated configuration reference stays complete.

## Decision

The Oryn business domain lives in `packages/synergy/src/oryn/` and is registered through `product-registration.ts` via `registerOrynDomain()`, the same manifest every other product domain uses. Registration only attaches the storage migration namespace; every runtime behavior (agents, tools, channel routing, server routes) checks `oryn.enabled` from the config before exposing anything. The `oryn` top-level config key is owned by the `runtime` domain (`120-runtime.jsonc`) and defaults to disabled, so a default installation behaves exactly like upstream Synergy. Storage keys for Oryn records live under a single `oryn` prefix defined in `src/oryn/path.ts`, migrated by the `oryn` domain migration registered with the central `MigrationRegistry`.

## Alternatives considered

**Gate registration itself on the config flag.** The manifest is loaded before config is read in every entry point, so conditional registration would either read config twice or race startup; registering only an inert migration keeps the one-load invariant.

**Ship Oryn as a plugin.** The proposal requires changes to Channel delivery, Host identity, agent permissions, and runtime admission that plugins cannot reach through public contracts; a first-party domain is required for the first version.

**Dedicated config domain file for Oryn.** A separate domain file would add a settings section for a disabled feature; owning the key under `runtime` keeps the dormant domain out of operator-facing defaults while the generated reference still documents the key.

## Consequences

Every Oryn behavior must remember the enable check — the domain is a no-op until each surface (agents, tools, channel, routes) is individually gated, and a missed gate would leak dormant behavior into stock Synergy. The single `oryn` storage prefix makes auditing and future retention policy straightforward. The config schema now carries the full Oryn surface up front, so schema and implementation can drift while batches land; the proposal remains the source of truth until the domain is complete.
