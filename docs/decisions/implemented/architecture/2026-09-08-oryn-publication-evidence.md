# Decision Record: Render Oryn publication from candidate evidence

Status: implemented

## Problem

Free-form PR text can omit the actual candidate or repeat author claims without independent evidence. A Draft body can also remain stale when later verification and review make the candidate ready for human inspection.

## Decision

The Oryn publication owner generates issue observations and PR sections. It verifies the assigned candidate worktree, reads a real Git name-status diff with external diff and text conversion disabled, and includes execution receipts only through accepted current worker reports. Review summaries require accepted reviewer assignments with matching candidate, baseline, review domain and existing policy/evidence digests. This reuses current evidence validation without claiming that receipt-reference digests establish complete policy authenticity.

The Mermaid scope map links base, changed files and candidate. It explicitly describes Git changes and does not infer runtime dependencies. The explanatory structure is informed by the [OpenClaw Feishu PR](https://github.com/openclaw/openclaw/pull/136382); no upstream body is copied. Actual source links and complete candidate versions accompany the graph.

Agent notes remain a bounded, escaped section. Known secrets and local paths are rejected; commands containing recognized private context are omitted, and private record IDs are replaced by public hash references. These checks are deliberately described as pattern validation rather than complete privacy classification. Raw logs are not published. The ready gate checks the generated body; the GitHub provider refreshes that body before the real Draft-to-ready mutation.

## Alternatives considered

**Accept a separate model-authored validation payload.** It does not prove that the text actually sent to GitHub is current or safe. The generated body is the gate input.

**Always draw a runtime architecture graph from filenames.** File changes cannot prove runtime dependencies. A factual scope map is useful but remains distinct from a verified architecture description.

**Publish author test claims as verification.** Accepted execution and independent review are separate sections, with missing evidence stated explicitly.

## Consequences

Behavioral tests cover real nonempty candidate capture, accepted verification and reviewer evidence in ready content, no independent payload requirement, body refresh before GitHub readiness, escaping, private-context rejection and empty-diff refusal. Network transport remains mocked; these tests do not establish live GitHub App permissions or end-to-end Feishu behavior. Progress labels and richer architecture descriptions remain separate publication work.
