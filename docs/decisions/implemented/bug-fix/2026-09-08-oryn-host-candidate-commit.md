# Decision Record: Host-owned Oryn candidate commits

Status: implemented

## Problem

The complete scripted engineering scenario reached the coder's real file tools but could not create a candidate commit. An autonomous linked worktree cannot write the Git metadata stored outside its writable source directory. Granting a general shell write access to the common Git directory would expose other branch and worktree metadata. The [incident](../../../postmortem/0012-oryn-candidate-commit-boundary.md) records the observed failure.

## Decision

The existing `oryn_result` tool exposes `input.kind: commit_candidate`. Only the active, unfrozen code assignment can use it. The Host validates the worker, repository, directory, assigned branch, Case epoch and Attempt before accepting explicit relative file paths and one conventional title. Repository Skill sources under `.synergy/skill` are supported; runtime metadata, protected agent metadata and symlink traversal are rejected. The model receives a candidate SHA and branch; submitting and freezing its candidate report remains a separate action.

The Host stages selected files into a private temporary index, rejects omitted source changes and empty commits, creates a commit through Git plumbing, and updates only the assigned branch with the expected baseline SHA. Repository hooks are not part of this operation; configured filters and submodules are rejected, and the existing restricted Git environment disables executable Git extensions. The independent check and review gates supply delivery evidence. The shell's filesystem permissions remain unchanged.

A generated commit trailer hashes the assignment and request content. An interrupted request can reuse exactly that commit when it is the direct child of the baseline and its tree still matches the selected source. Replay repairs the worktree index after an interruption following the ref update. Different request content, another branch head, changed source, protected paths and an already frozen Attempt are rejected. The Host does not reset source files or update the main branch. A failed compare-and-set leaves the competing ref intact; an unreachable commit object can be garbage-collected by ordinary Git maintenance.

Tool admission routes only this result action to the existing local-process executor with one commit slot per Case. The tool retains physical execution until Git cleanup completes. Git commands have bounded output, cancellation and per-command deadlines; the Case lock serializes the local operation with control transitions. No new Session runtime, queue, database or persisted JSON schema is introduced.

## Alternatives considered

**Grant shell access to the shared Git directory.** This would make ordinary commits work but also widen generic process access to unrelated branch and worktree metadata.

**Commit source from the mock driver.** That would hide the missing product operation and could not prove the model-facing pipeline works.

**Allow shell sandbox bypass.** This would weaken the intended autonomous execution model and expose host resources unrelated to candidate preparation.

## Consequences

Coder prompts use Host commit creation, followed by the normal candidate report. The successful scripted pipeline exercises real file reads/writes, commit creation, frozen candidate verification, independent execution and structured review before the publication ledger and captured reporter delivery. GitHub transport and model judgments are simulated; this does not prove live App permissions, model reasoning, all repository build systems or complete coder-shell containment.
