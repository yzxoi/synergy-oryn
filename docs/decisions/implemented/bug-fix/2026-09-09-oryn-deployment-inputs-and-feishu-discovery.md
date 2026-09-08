# Decision Record: Accept Bun workspace objects and discover Feishu groups

Status: implemented

## Problem

Oryn dependency sealing rejected Bun's object workspace declaration, including repositories that use catalogs. Oryn setup also depended on managed Feishu group records, while the Feishu provider offered no group discovery operation. A connected account could therefore have no selectable notification group.

## Decision

Dependency sealing accepts either a workspace string array or an object with a string-array `packages` field. The complete tracked root manifest remains part of snapshot identity, so catalog changes invalidate the snapshot. Malformed declarations and copied local dependencies remain rejected.

Feishu implements the existing Channel project-refresh port using the authenticated group-list API. Discovery reads all pages before reconciling managed group metadata. Invalid responses, repeated cursors, cancellation and bounded pagination failures never trigger negative reconciliation. This operation creates no conversation or model work. Existing Feishu conversation Scope routing remains unchanged.

Channels settings and the account sidebar expose explicit refresh. Errors remain visible and groups become selectable through the existing Oryn setup API. The picker also retains the installation-configured notification target while its account is enabled, even before discovery. Feishu group listing excludes direct chats; absence from that listing must not silently clear an operator-authorized destination when saving other settings. This preserves only the existing configured identity, not arbitrary submitted IDs. No new persistence or API schema is introduced.

## Alternatives considered

**Require workspace arrays.** This would force users to rewrite supported Bun manifests and remove catalog declarations just to provision dependencies.

**Seed notification records by editing storage.** This hides the missing provider capability and does not support routine setup or membership changes.

**Refresh groups during every connection.** Making discovery explicit avoids adding a group-list permission requirement to ordinary Feishu messaging startup.

## Consequences

Group discovery requires the Feishu application's group-list permission and bot membership. Operators refresh membership explicitly. Snapshots still require matching platform, Bun version and tracked inputs. A successful dependency seal does not establish OS sandbox readiness; deployment must exercise the actual namespace and proc mount, then the Oryn execution path.

## Validation

Real Git fixtures cover object workspace sealing, catalog invalidation and malformed declarations. Local HTTP fixtures cover complete pagination, failure, repeated cursors and abort with durable ownership records. Existing setup and Channel Host tests verify downstream discovery and reconciliation. Frontend capability tests verify that Feishu exposes refresh while diagnostics remain hidden.
