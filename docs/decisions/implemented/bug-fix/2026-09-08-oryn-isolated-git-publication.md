# Decision Record: Isolate Oryn credential-bearing Git publication

Status: implemented

## Problem

The publishing Host used the candidate checkout's `origin`, Git configuration and hooks while carrying an installation token and inherited process environment. A repository URL rewrite or hook could redirect publication or execute with credentials. Generic push failures also lacked the uncertainty classification needed by the durable action ledger.

## Decision

The GitHub publish transport runs Git in a private temporary bare repository under the Host cache. It resolves the frozen candidate's object directory without credentials, checks the full SHA and branch, and supplies the object directory as an alternate to the private repository. Linked worktrees share their object store without supplying their configuration. The executable resolves to a Host-installed Git outside the candidate directory.

The child environment includes only the absolute executable search path, fixed Git controls and the per-call installation token/path. System/global config and inherited Git, shell startup, proxy and credential settings are excluded. The push URL is constructed from the validated repository identity; HTTPS is the only allowed protocol, redirects are disabled, and the credential helper responds only for HTTPS, github.com and the exact repository path. Tokens do not appear in arguments or persisted files. The ordinary GitHub Channel credential helper retains its existing behavior.

Git pushes an explicit SHA to one branch without force, signing or submodule recursion. Commands have a two-minute timeout and bounded stdout; stderr is discarded. Owned POSIX process groups are killed on cancellation and cleanup, and the direct child is awaited before scratch removal. Git porcelain identifies a non-fast-forward rejection; other transport failures yield a typed uncertain outcome that the existing action ledger reconciles before another write. Raw process diagnostics do not enter errors or logs.

## Alternatives considered

**Override hooks and continue pushing from the candidate checkout.** Disabling hooks does not exclude repository URL rewrites, credential helpers or other transport configuration.

**Copy the whole repository.** A private bare repository with an object alternate avoids copying large histories and preserves the exact candidate objects. It does require that the object store remain available through publication.

**Use the ordinary credential command builder.** Its inherited environment is intentional for ordinary Channel operations. Tightening it globally would change unrelated user behavior.

## Consequences

The regression test first reproduced a redirected push with the original code. Real Git push and receive-pack tests replace only the HTTPS helper transport and verify exact remote commit delivery, hostile hook/helper/rewrite isolation, ambient environment removal, linked worktrees, credential host/path matching, real remote divergence, redacted failure and process-group cancellation. Host ledger tests verify uncertain Git failures reconcile as ambiguous. Linux native CI includes the Git transport suite.

This is POSIX github.com publication. It does not configure GitHub Enterprise, custom proxies or private certificate authorities, and tests do not exercise live GitHub HTTPS authentication. Host executable installation and operating-system trust remain deployment responsibilities. Abrupt Host termination can leave an uncredentialed temporary repository for stopped-runtime cleanup; this change does not claim full PR-success recovery across process death.
