import { initTRPC } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import superjson from "superjson";

import {
  readSessionToken,
  serializeExpiredSessionCookie,
  verifySessionToken,
} from "@/server/auth/session";
import { prisma } from "@/server/db";

export async function createTRPCContext(opts: FetchCreateContextFnOptions) {
  const session = verifySessionToken(readSessionToken(opts.req.headers.get("cookie")));
  const user = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { id: true, email: true, name: true, avatarUrl: true },
      })
    : null;

  if (session && !user) {
    opts.resHeaders.append("Set-Cookie", serializeExpiredSessionCookie());
  }

  return {
    prisma,
    req: opts.req,
    resHeaders: opts.resHeaders,
    user,
  };
}

type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});
