# Decision Record: Budget the complete CI test job including report upload

Status: implemented

## Problem

The Test job includes package suites, browser and release checks, sandbox setup, sequential core shards and report upload. A measured run completed every test step successfully in about 23 minutes, then spent another four minutes uploading its reports. The 25-minute job limit cancelled the job despite successful test steps and a completed upload.

## Decision

The Test job has a 35-minute wall-clock budget covering setup, execution, artifact upload and teardown. Individual test timeouts, suite selection, assertions and required-check behavior remain unchanged. The measured execution and step conclusions are available in the [CI Test job](https://github.com/yzxoi/synergy-oryn/actions/runs/34212890564/job/102017784062).

## Alternatives considered

**Drop report upload.** Reports are needed to diagnose shard failures; removing them would reduce the evidence available for regressions.

**Increase individual test timeouts.** The tests completed successfully within their own bounds. The exhausted budget belongs to the whole job, including transport and setup.

## Consequences

The job retains a finite timeout and enough measured headroom for report upload. This adjustment does not resolve unrelated assertion failures or establish success for a new commit; each commit still requires its own CI result.
