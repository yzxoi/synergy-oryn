# Decision Record: Measure Oryn entry behavior alongside subprocess acceptance

Status: implemented

## Problem

The native and CLI subprocess suites execute the Oryn resource runner and dependency-sealing command, but their execution is outside the parent Bun coverage process. The coverage gate correctly reports both entry modules as never loaded even when those subprocess scenarios pass.

## Decision

Direct behavioral tests supplement the process suites. The registered dependency command runs through Yargs, writes a real sealed artifact, preserves it on duplicate-output failure and restores its signal handlers. The trusted resource entry receives a valid plan outside its designated OS scope and must reject execution without producing a command marker or success evidence. Tests restore the process exit status explicitly, including Bun's default zero status.

## Alternatives considered

**Exempt the modules from coverage.** Their direct behavior is testable without bypassing containment, so an exemption would hide useful checks.

**Replace subprocess acceptance.** In-process rejection does not prove actual cgroup enforcement or executable bootstrap behavior. Native execution and product CLI tests remain required.

## Consequences

The parent coverage process measures command dispatch and rejection behavior. Native tests separately prove successful constrained execution, exhaustion, cancellation and process bootstrap. Coverage thresholds and the exemption manifest remain unchanged.
