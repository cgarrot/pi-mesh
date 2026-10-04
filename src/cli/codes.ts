// cli/codes.ts — the CLI exit-code contract (plan D5). Stable, documented
// in the README and asserted by tests: scripts must be able to branch on
// honest outcomes without parsing stdout.
//
//   0 success (delivered / reply / complete verdict)
//   1 mesh failure (blocked:<reason>, error:<reason>, broker unreachable)
//   2 usage error (bad args — stderr carries the usage line)
//   3 expired / wait timeout (a late reply is still delivered)
//   4 honest partial (queued_offline, broadcast deliveredCount < totalCount,
//     wait verdict timeout/cancelled WITH answers received)
export const EXIT_OK = 0;
export const EXIT_MESH_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_EXPIRED = 3;
export const EXIT_PARTIAL = 4;
