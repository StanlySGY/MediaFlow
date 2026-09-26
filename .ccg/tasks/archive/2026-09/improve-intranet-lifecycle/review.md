# Review

## Scope

This review covers the complete working-tree change set for the trusted-intranet,
single-user, single-machine lifecycle improvement. The review standard treats
local resource exhaustion, stale state, and long-running reliability as the
primary risks; public-network authentication, multi-tenant ownership, Redis,
and generic SSRF hardening are outside this task's scope.

## External Review Attempts

- Antigravity via `codeagent-wrapper` did not produce a report because headless
  mode required a denied `command` permission.
- Claude via `codeagent-wrapper` exited without a report. A direct native retry
  failed authentication with `401 Invalid API key`.
- A direct Antigravity read-only retry returned repository context and a plan
  confirmation instead of a review report. It was interrupted before any file
  operation; the worktree was rechecked and contains no changes from that
  process.

These failures are environment/tooling failures, not approvals. The findings
below are from local source inspection, targeted regression tests, and the full
quality gate.

## Findings

### Critical

None.

### Warning

None.

### Info / P2

1. File-task SSE does not automatically reconnect after a transport error;
   `frontend/src/hooks/useFileTask.ts:266-270` closes the stream and leaves
   status polling as the fallback. This is acceptable for the current local
   tool, but an explicit reconnect/backoff policy would improve recovery.
2. The manual realtime view treats an SSE transport error as a failed session
   and asks the user to retry at `frontend/src/components/RealtimeView.tsx:212-220`.
   The browser recorder follows the same policy at
   `frontend/src/components/RealtimeRecorderPanel.tsx:160-170`. This avoids
   retaining a session whose event stream is no longer observable, but it is
   less seamless than reconnect-and-replay.
3. File ASR concurrency is bounded per task, not globally: a new semaphore is
   created in `app/services/stream_manager.py:610-614` for each task. Multiple
   simultaneous tasks can therefore exceed the intended single-machine ASR
   concurrency budget. This remains a P2 throughput concern, not a lifecycle
   correctness blocker.
4. View selection remains in React state rather than the URL at
   `frontend/src/App.tsx:86-102`, so browser refresh/deep-link recovery is not
   available. This is a UX polish item unrelated to resource cleanup.

## Local Review Conclusion

The lifecycle changes close the reported P1 failure modes: realtime capacity
reservation is atomic, provider failures become terminal and release upstream
resources, terminal realtime sessions are TTL-evicted, file-task clear requests
backend cancellation, stale browser callbacks are generation-guarded, and
terminal task output/state files are cleaned both on demand and periodically.
The HTTP realtime provider now propagates downstream `/end` failures instead of
silently leaving the local session in a misleading finishing state.

**Verdict: APPROVE for the trusted-intranet single-machine scope.**

## Quality Gate

- Backend: `183 passed`
- Frontend: `26 passed`
- Frontend production build: passed
- ESLint: passed
- Ruff: passed
- `docker compose config --quiet`: passed
- `git diff --check -- ':!handoff.md'`: passed
