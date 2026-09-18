// extension/inbound-policy.ts — pure, opt-in broadcast delivery policy.
import type { MeshFrame } from "../protocol/envelope.js";
import type { InboundBroadcastPolicy } from "../shared/config.js";

export function classifyInbound(
  frame: MeshFrame,
  selfAlias: string,
  policy: InboundBroadcastPolicy = "immediate",
  matchedReply: boolean = false,
): InboundBroadcastPolicy {
  // PendingReplies matches normally bypass inbound (client.ts, reply case).
  // Exception: LAUNCH wake-on-answer emits inbound with matchedReply=true.
  // Preserve that wake; unmatched/orphan replyAll frames remain broadcasts.
  if (policy !== "deferred" || matchedReply) return "immediate";
  if (frame.priority === "urgent" || frame.priority === "force") return "immediate";
  if (frame.type !== "msg" && frame.type !== "mailbox" && frame.type !== "reply") return "immediate";
  if (frame.broadcast !== true && frame.replyAll !== true) return "immediate";
  const alias = selfAlias.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Aliases may contain hyphens: do not mistake @me-other for @me.
  const mention = new RegExp(`(?:^|[^\\w-])@?${alias}(?![\\w-])`, "i");
  return alias === "" || mention.test(frame.body ?? "") ? "immediate" : "deferred";
}
