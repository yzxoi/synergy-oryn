# Decision Record: Bound Oryn Git reads for repository data

Status: implemented

## Problem

Dependency sealing reads the complete recursive Git tree to bind installed dependencies to tracked inputs. The shared Git reader capped subprocess output at 64 KiB, smaller than the maintained repository's tree listing. Bun terminated the read, and sealing reported that the assigned Git state could not be verified. Small dependency fixtures did not cross the output limit.

## Decision

The shared Git reader permits up to 64 MiB of subprocess output. Git tree listings, tracked manifests and diffs are structured repository input rather than short diagnostic messages. The existing ten-second deadline, isolated Git configuration, nonzero-exit rejection and sandbox boundaries remain unchanged. Failed or truncated reads never become accepted dependency inputs.

The dependency sealing suite includes a real committed repository whose recursive tree exceeds one MiB and verifies successful sealing, complete tree output and retention of the workspace package input.

## Alternatives considered

**Remove the output bound.** Repository-controlled output still needs a finite resource ceiling.

**Truncate the recursive listing.** This can omit dependency inputs and produce an invalid snapshot identity.

## Consequences

Large repository metadata can be read without treating normal output as a Git failure. Peak memory per concurrent read can increase; the larger cap is not a promise of support for arbitrarily large repositories. Reads beyond the bound still fail instead of accepting partial data. The fix does not change ownership checks, dependency validation or public tool-output limits.
