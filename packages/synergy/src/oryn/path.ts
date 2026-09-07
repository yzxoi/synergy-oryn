import { Identifier } from "@/id/id"

type ScopeID = Identifier.ScopeID

/**
 * Storage keys for the Oryn feedback-to-PR domain. All Oryn records live under
 * a single "oryn" prefix so fresh installs and upgrades share one layout and
 * the namespace can be audited as a whole. Raw provider identity strings are
 * never used as path segments; hashed keys are produced by the store layer.
 */
export namespace OrynPath {
  export const orynRoot = () => ["oryn", "meta"]

  /** Persistent intake claims keyed by normalized source key (dedup + crash recovery). */
  export const claimsRoot = () => ["oryn", "claims"]
  export const claim = (sourceKeyHash: string) => [...claimsRoot(), sourceKeyHash]

  /** Immutable source anchors (Feishu chat/thread/message, GitHub issue/PR events). */
  export const sourcesRoot = () => ["oryn", "sources"]
  export const source = (sourceHash: string) => [...sourcesRoot(), sourceHash]

  /** Case records, the authoritative problem/collaboration association. */
  export const casesRoot = () => ["oryn", "cases"]
  export const caseRoot = (caseId: string) => [...casesRoot(), caseId]
  export const caseInfo = (caseId: string) => [...caseRoot(caseId), "info"]

  /** Versioned candidate validation cycles per case. */
  export const attemptsRoot = (caseId: string) => [...caseRoot(caseId), "attempts"]
  export const attempt = (caseId: string, attemptId: string) => [...attemptsRoot(caseId), attemptId]

  /** Host-bound worker task identities (recovery anchor for spawned sessions). */
  export const assignmentsRoot = (caseId: string) => [...caseRoot(caseId), "assignments"]
  export const assignment = (caseId: string, assignmentId: string) => [...assignmentsRoot(caseId), assignmentId]

  /** Trusted executor run receipts, written only by the check executor. */
  export const runsRoot = (caseId: string) => [...caseRoot(caseId), "runs"]
  export const run = (caseId: string, runId: string) => [...runsRoot(caseId), runId]

  /** Structured reviewer reports (model judgment, host-validated references). */
  export const reviewsRoot = (caseId: string) => [...caseRoot(caseId), "reviews"]
  export const review = (caseId: string, reviewId: string) => [...reviewsRoot(caseId), reviewId]

  /** External action ledger: every GitHub/notification write intent and outcome. */
  export const actionsRoot = () => ["oryn", "actions"]
  export const action = (actionId: string) => [...actionsRoot(), actionId]

  /** GitHub poll cursors per configured repository alias. */
  export const pollCursorsRoot = () => ["oryn", "poll_cursors"]
  export const pollCursor = (repoAlias: string) => [...pollCursorsRoot(), repoAlias]

  /** Verified-memory learning candidates awaiting host promotion. */
  export const learningRoot = () => ["oryn", "learning"]
  export const learning = (candidateId: string) => [...learningRoot(), candidateId]

  /** Case index entries per scope (derived, rebuildable). */
  export const caseIndexRoot = (scopeID: ScopeID) => ["oryn", "case_index", scopeID as string]
  export const caseIndexEntry = (scopeID: ScopeID, caseId: string) => [...caseIndexRoot(scopeID), caseId]
}
