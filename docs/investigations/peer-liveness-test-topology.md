# Peer liveness test topology

Verified on 2026-09-08 against baseline e934b38e8271da7673fae78aa03d6139316a1bb9.

The unchanged round-trip suite produced 98 passed / 0 failed, then 95 / 3 twice. The failures were `recipient_alive: false`, an unexpected dead-recipient warning, and `tester-1` reported inactive. Both server processes were still alive.

## Cause and independent evidence

The server deliberately registers the current identity in `active/<process.ppid>.txt`. One Claude session is the parent of one server, and parent identity survives server restarts. `isPeerAlive` and `listPeerInfo` read that registry and check the registered parent's process liveness. The round-trip fixture instead spawned both named servers directly from one test process. They overwrote the same file.

A coordinator probe used the actual unchanged server, a fresh temporary HOME for each order, and direct signal-zero checks of both owned server processes:

| Initialized first | Initialized last | Active identity files | Recipient alive | Warning | Tester alive |
| --- | --- | --- | --- | --- | --- |
| tester-1 | auditor | One, containing auditor | false | yes | false |
| auditor | tester-1 | One, containing tester-1 | true | no | true |

Both owned children were alive in both rows. The probe stopped its children and removed its temporary HOME. No existing bus sessions were used. This reproduces all three failures by changing startup order alone. It establishes a fixture defect, not a production process-liveness defect.

A separate native read-only diagnosis reviewed the supplied source and these observations. It did not run the tests. The coordinator independently checked its recommendation against the actual source and probe before editing.

## Decision

Give each test session a small dedicated parent process that starts the actual server with inherited transport descriptors. Both sessions still share one temporary HOME and communicate over the real bus. Their identity files now have distinct, realistic parent process IDs.

Serializing startup alone would only select which name loses its registry entry. Changing production registry keys would alter session persistence and hook lookup without evidence of a production defect. Separate HOME directories would prevent the required shared-bus round trip. These alternatives were rejected.

## Regression and cleanup

The standard suite now runs tester-first, auditor-first, and concurrent startup, with a fresh temporary HOME each time. Each run checks exactly two registry files, distinct host process IDs, correct identity contents, both server processes alive, and all existing round-trip assertions. The explicit tester re-claim remains necessary because earlier tests deliberately change its identity; it no longer compensates for registry overwrite.

The host forwards termination to only its child, waits for that child to close, and escalates to SIGKILL after one second if needed. Parent IPC disconnection also stops the child. The round-trip fixture waits for cleanup and verifies its owned server processes are absent before removing the temporary HOME. Two lifecycle tests exercise SIGTERM and parent disconnection. The three-order runner has a 60-second bound for each complete round trip.

Final validation: `npm test` passes 34 smoke assertions, 102 round-trip assertions for each of three startup orders, 6 claim-flow assertions, and 116 focused tests (including both new lifecycle tests). Production server, storage, hooks, and native executor files are unchanged. Existing real workers are untouched.

## Limits and rollback

The runtime observations were collected on one macOS machine. No claim is made about every possible real supervisor topology. A deployment that deliberately hosts two differently named servers under one parent would need a separate production investigation covering registry, hooks, and restart persistence.

This is a test and documentation change. Reverting this commit restores the old fixture and intermittent failure; no production migration, runtime restart, credential change, or launch allowance adjustment is required.
