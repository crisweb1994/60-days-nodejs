import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { readSessionToken, verifySessionToken } from "@/server/auth/session";
import { requireMembership } from "@/server/auth/workspace-access";
import { prisma } from "@/server/db";
import { toRealtimeUser } from "@/server/realtime/events";
import { realtimeEventBus } from "@/server/realtime/event-bus";
import { encodeSseEvent } from "@/server/realtime/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const session = verifySessionToken(readSessionToken(request.headers.get("cookie")));
  if (!session) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, avatarUrl: true },
  });
  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { workspace } = await requireMembership(prisma, user.id, params.slug);
  const realtimeUser = toRealtimeUser(user);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: Parameters<typeof encodeSseEvent>[0]) => {
        controller.enqueue(encodeSseEvent(event));
      };
      const unsubscribe = realtimeEventBus.subscribe(workspace.id, {
        id: randomUUID(),
        user: realtimeUser,
        send,
      });
      const heartbeat = setInterval(() => {
        send({ type: "ping", at: new Date().toISOString() });
      }, 25_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
