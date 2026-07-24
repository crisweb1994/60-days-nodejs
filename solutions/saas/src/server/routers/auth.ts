import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createSessionToken,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "@/server/auth/session";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { protectedProcedure, publicProcedure, router } from "@/server/trpc";

const emailSchema = z.string().trim().email().max(255).toLowerCase();
const passwordSchema = z.string().min(8).max(128);

function publicUser(user: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}) {
  return user;
}

export const authRouter = router({
  register: publicProcedure
    .input(
      z.object({
        email: emailSchema,
        password: passwordSchema,
        name: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existingUser = await ctx.prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existingUser) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Email is already registered",
        });
      }

      const user = await ctx.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
        },
        select: { id: true, email: true, name: true, avatarUrl: true },
      });

      ctx.resHeaders.append(
        "Set-Cookie",
        serializeSessionCookie(createSessionToken(user.id)),
      );

      return {
        user: publicUser(user),
      };
    }),

  login: publicProcedure
    .input(
      z.object({
        email: emailSchema,
        password: z.string().min(1).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { email: input.email },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          passwordHash: true,
        },
      });

      if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid email or password",
        });
      }

      ctx.resHeaders.append(
        "Set-Cookie",
        serializeSessionCookie(createSessionToken(user.id)),
      );

      return {
        user: publicUser(user),
      };
    }),

  me: publicProcedure.query(({ ctx }) => {
    return {
      user: ctx.user,
    };
  }),

  logout: protectedProcedure.mutation(({ ctx }) => {
    ctx.resHeaders.append("Set-Cookie", serializeExpiredSessionCookie());

    return {
      ok: true,
    };
  }),
});
