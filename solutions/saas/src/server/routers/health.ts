import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { publicProcedure, router } from "@/server/trpc";

export const healthRouter = router({
  ping: publicProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const startedAt = Date.now();

      try {
        await ctx.prisma.$queryRaw`SELECT 1`;

        return {
          ok: true,
          service: "saas-task-platform",
          database: "up",
          durationMs: Date.now() - startedAt,
          checkedAt: new Date().toISOString(),
        };
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database health check failed",
        });
      }
    }),
});
