// inject.ts — how inbound mesh frames reach an OpenCode session.
//
// The heavy lifting (formatting, priority→delivery mapping, batching
// strategy) is shared with the Pi adapter and reused here:
//   - formatInboundContent and buildBatchMessage come from the shared
//     extension modules (inbound.ts / batcher.ts).
// Only the host-specific step — turning the prepared text into an
// OpenCode prompt — lives in this file.
import { formatInboundContent } from "../extension/inbound.js";
import { buildBatchMessage } from "../extension/batcher.js";
import type { DeliverAs } from "../extension/pi-types.js";
import type { MeshDelivery, MeshSessionRuntime } from "./client-runtime.js";
import type { MeshFrame } from "../protocol/envelope.js";

/**
 * Inject a batched set of inbound frames into the session's OpenCode run:
 * the text prepared by buildBatchMessage, delivered with the delivery
 * mode chosen by the batch (the most interrupting one).
 */
export async function injectBatch(
  runtime: MeshSessionRuntime,
  frames: readonly MeshFrame[],
): Promise<void> {
  const batch = buildBatchMessage(frames as MeshFrame[], (frame) => runtime.formatFor(frame));
  await runtime.submit(batch.content, toDelivery(batch.deliverAs));
}

/**
 * Inject ONE inbound frame (bypassing the batcher — force/remind frames
 * and single messages). `interrupt: true` aborts the session's running
 * turn first (force delivery), like Pi's abort path.
 */
export async function injectFrame(
  runtime: MeshSessionRuntime,
  frame: MeshFrame,
  options: { interrupt?: boolean } = {},
): Promise<void> {
  if (options.interrupt === true) {
    runtime.interrupt?.();
  }
  const text = formatInboundContent(frame, {
    ...runtime.formatFor(frame),
    replyChain: (frame as unknown as { __replyChain?: boolean }).__replyChain === true,
  });
  await runtime.submit(text, toDelivery(frameDelivery(frame)));
}

/** The frame's own delivery wish, before the batcher's aggregation.
 *  (force keeps its abort path via `options.interrupt`; delivery is steer.) */
function frameDelivery(frame: MeshFrame): DeliverAs {
  if (frame.priority === "force" || frame.priority === "urgent") return "steer";
  if (frame.type === "reply") return "steer";
  return "followUp";
}

/** Map the shared delivery mode onto OpenCode's two delivery modes. */
function toDelivery(deliverAs: DeliverAs): MeshDelivery {
  return deliverAs === "steer" ? "steer" : "queue";
}
