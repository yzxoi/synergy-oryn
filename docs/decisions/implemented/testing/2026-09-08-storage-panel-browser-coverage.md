# Decision Record: Exercise snapshot storage maintenance in the browser

Status: implemented

## Problem

The synced snapshot storage panel was absent from test coverage. The coverage gate correctly failed the App even though its aggregate percentages exceeded their floors. The panel contains destructive-maintenance confirmation wiring that needs behavioral verification.

## Decision

A hermetic Vite/Chromium fixture loads the real Solid StoragePanel, controls and Lingui provider. SDK responses, confirmation delivery and toast transport are fixture seams; the actual panel calls the generated SDK method shapes and owns preview, confirmation callback, outcome handling and refresh. Tests exercise project usage, keyboard snapshot preference changes, preview-before-apply for cleanup/migration/packing, failed previews, failed apply results, empty cleanup and failed usage refresh recovery.

The package runner serializes this browser suite alongside existing Playwright fixtures. A fixture-local Vite cache, random loopback port and explicit dependency optimization keep browser startup independent of concurrent suites. Each test owns a fresh browser page/context; the fixture disables HMR and closes its HTTP connections during teardown. Cleanup closes the page, browser and fixture server without touching a product runtime.

Running this suite with Bun coverage produces host-preload records, not coverage for the TSX executed by Chromium. An exact StoragePanel.tsx exemption documents this instrumentation boundary and names the behavioral suite. No broad panel exemption or coverage-floor reduction is introduced.

## Alternatives considered

**Import the file without exercising the component.** This could appease missing-file accounting while leaving maintenance behavior unverified.

**Assert source strings.** Source spelling cannot prove that an apply request waits for confirmation or that errors prevent a success result.

**Exempt the panel without a behavioral suite.** That would hide the gap reported by CI.

## Consequences

The suite verifies component interaction against controlled SDK results; it does not execute snapshot deletion or prove the backend maintenance implementation. Those operations retain their core tests. Browser coverage remains a distinct evidence source from Bun lcov percentages.
