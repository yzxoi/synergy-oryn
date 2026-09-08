# Decision Record: Assignment-bound Oryn worker shell containment

Status: implemented

## Problem

Oryn coding and reproduction used ordinary Bash execution with the host HOME and interactive runtime read roots. Removing GitHub environment variables alone did not prevent host credential-file reads. Ordinary Git inspection needs repository objects and path traversal, but exposing shared Git metadata also exposes configuration and hooks. Explicit background requests were ignored by the local backend, and a background descendant ignoring SIGTERM could keep writing after its parent was reported finished.

## Decision

A Host-only Bash execution policy registry is consumed by the central ToolResolver after capability authorization. Oryn selects an explicit local policy from its persisted worker binding and active assignment; custom tool sources and remote target fields are rejected before executor invocation. Preparation checks the current Case control, epoch, Attempt, report acceptance, agent identity, assigned workspace and repository again. Similar names outside the reserved Oryn catalog do not acquire this policy.

Linux metadata protection uses the helper's named-metadata rules, which distinguish existing mounts from absent paths covered by the creation monitor. It does not duplicate missing metadata paths as required bind sources. The shell fixes helper logging at error level so normal absent-metadata warnings do not pollute command output; startup errors remain visible.

The shell receives a private disposable HOME/temp directory, an environment without provider credentials or language startup variables, restricted networking and only its assigned source plus required runtime files. Reproduction and coding can write source before candidate freeze. Frozen source remains read-only under every interactive permission profile. Sandbox unavailability is an execution failure with no unwrapped fallback. The macOS explicit-profile compiler grants only ancestor metadata for path traversal; parent listings and sibling file data remain unavailable.

A private Git directory contains the assigned HEAD/ref, a copied index and a minimal configuration, with read-only access to the original object store. Git status/diff operate inside this view. Shell staging and commits do not change canonical repository metadata; the existing Host candidate action owns durable branch changes. Runtime executable files may be readable outside system directories without exposing their entire user-home parent.

Local Bash honors explicit background requests and keeps the existing ProcessRegistry lifecycle. Host policy survives the foreground response. Oryn completion terminates the owned process group, including the shared SIGKILL escalation, before asynchronous scratch removal and the finished record. Ordinary interactive shell policy remains unchanged. Agent instructions distinguish exploratory commands from controlled check receipts and require environment reports for unsupported workloads.

## Alternatives considered

**Strip credential environment variables only.** Filesystem reads still reach host configuration and secrets.

**Expose the original Git directory.** That also exposes remotes, authentication configuration and hook paths. The private metadata view supports inspection with a smaller read surface.

**Implement a separate shell runner for Oryn.** This would duplicate process ownership, output handling, background interaction and tool presentation instead of reusing the existing backend.

**Allow sandbox fallback or remote execution with the same arguments.** Neither preserves the assignment's verified local roots and environment policy.

## Consequences

Worker shells require the supported macOS or Linux explicit sandbox. Git inspection does not support every unusual repository layout; external object alternates and shared/split indexes can require a separately supported environment. No network dependency installation, persistent build staging, cgroup resource guarantee, author lease across candidate freeze, host plugin isolation or protection from already committed secrets follows from this change. An assignment takeover rejects subsequent preparation; cancelling a command already running at takeover remains a distinct lifecycle responsibility. Abrupt host termination may leave disposable scratch.

`test/oryn/shell.test.ts` exercises the real ToolResolver and process backend for private environment, host-file exclusion and macOS parent-list denial, writable source/Git inspection, frozen source, network denial, background ownership, SIGTERM-resistant descendants, unavailable sandbox, ownership changes, workdir and remote rejection. Shared Bash, profile, virtual-file, process and explicit-profile suites check ordinary runtime behavior. The native workflow runs the shell suite on Ubuntu 22.04 and 24.04; macOS results alone do not establish Linux execution. Successful shell commands remain development observations, not independent delivery receipts.
