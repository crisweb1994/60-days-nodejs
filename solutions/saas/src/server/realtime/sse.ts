import type { RealtimeEvent } from "@/server/realtime/events";

const encoder = new TextEncoder();

export function encodeSseEvent(event: RealtimeEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
