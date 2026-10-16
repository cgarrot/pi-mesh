// inject.ts — how an inbound mesh frame reaches an OpenCode session.
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
  const batch = buildBatchMessage(frames as MeshFrame[]);
  await runtime.submit(batch.content, toDelivery(batch.deliverAs));
}

/**
 * Inject ONE inbound frame (not batched) into the session.
 * Exposed for tests / callers that already hold a single frame.
 */
export async function injectFrame(
  runtime: MeshSessionRuntime,
  frame: Parameters<typeof formatInboundContent>[0],
): Promise<void> {
  const text = formatInboundContent(frame);
  await runtime.submit(text, "queue");
}

/** Map the shared delivery mode onto OpenCode's two delivery modes. */
function toDelivery(deliverAs: DeliverAs): MeshDelivery {
  return deliverAs === "steer" ? "steer" : "queue";
}
