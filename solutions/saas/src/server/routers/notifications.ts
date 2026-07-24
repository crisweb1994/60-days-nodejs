import { NotificationType } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  requireMembership,
  workspaceSlugSchema,
} from "@/server/auth/workspace-access";
import { decodeCursor, encodeCursor } from "@/server/domain/cursor";
import { protectedProcedure, router } from "@/server/trpc";

const limitSchema = z.number().int().min(1).max(100).default(30);

export const notificationsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        unreadOnly: z.boolean().default(false),
        limit: limitSchema,
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      let cursor = null;
      try {
        cursor = input.cursor ? decodeCursor(input.cursor) : null;
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
      }
      const createdAt =
        cursor && typeof cursor.value === "string"
          ? new Date(cursor.value)
          : null;
      if (createdAt && Number.isNaN(createdAt.getTime())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
      }

      const notifications = await ctx.prisma.notification.findMany({
        where: {
          workspaceId: workspace.id,
          recipientId: ctx.user.id,
          visibleInApp: true,
          readAt: input.unreadOnly ? null : undefined,
          OR:
            cursor && createdAt
              ? [
                  { createdAt: { lt: createdAt } },
                  { createdAt, id: { lt: cursor.id } },
                ]
              : undefined,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          data: true,
          readAt: true,
          emailStatus: true,
          createdAt: true,
          actor: {
            select: { id: true, email: true, name: true, avatarUrl: true },
          },
        },
      });
      const hasMore = notifications.length > input.limit;
      const page = hasMore ? notifications.slice(0, input.limit) : notifications;
      const last = page.at(-1);

      return {
        notifications: page,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({ value: last.createdAt.toISOString(), id: last.id })
            : null,
      };
    }),

  unreadCount: protectedProcedure
    .input(z.object({ workspaceSlug: workspaceSlugSchema }))
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const count = await ctx.prisma.notification.count({
        where: {
          workspaceId: workspace.id,
          recipientId: ctx.user.id,
          visibleInApp: true,
          readAt: null,
        },
      });
      return { count };
    }),

  markRead: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        notificationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const result = await ctx.prisma.notification.updateMany({
        where: {
          id: input.notificationId,
          workspaceId: workspace.id,
          recipientId: ctx.user.id,
          visibleInApp: true,
        },
        data: { readAt: new Date() },
      });
      if (result.count === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Notification not found",
        });
      }
      return { ok: true };
    }),

  markAllRead: protectedProcedure
    .input(z.object({ workspaceSlug: workspaceSlugSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const result = await ctx.prisma.notification.updateMany({
        where: {
          workspaceId: workspace.id,
          recipientId: ctx.user.id,
          visibleInApp: true,
          readAt: null,
        },
        data: { readAt: new Date() },
      });
      return { updatedCount: result.count };
    }),

  preferences: protectedProcedure
    .input(z.object({ workspaceSlug: workspaceSlugSchema }))
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const preference = await ctx.prisma.notificationPreference.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.user.id,
            workspaceId: workspace.id,
          },
        },
      });
      return {
        preference:
          preference ?? {
            userId: ctx.user.id,
            workspaceId: workspace.id,
            inAppEnabled: true,
            emailEnabled: true,
            taskAssigned: true,
            taskCommented: true,
            taskStatusChanged: false,
            updatedAt: null,
          },
      };
    }),

  updatePreferences: protectedProcedure
    .input(
      z
        .object({
          workspaceSlug: workspaceSlugSchema,
          inAppEnabled: z.boolean().optional(),
          emailEnabled: z.boolean().optional(),
          taskAssigned: z.boolean().optional(),
          taskCommented: z.boolean().optional(),
          taskStatusChanged: z.boolean().optional(),
        })
        .refine(
          (input) =>
            Object.keys(input).some((key) => key !== "workspaceSlug"),
          "At least one preference must be provided",
        ),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const data = {
        inAppEnabled: input.inAppEnabled,
        emailEnabled: input.emailEnabled,
        taskAssigned: input.taskAssigned,
        taskCommented: input.taskCommented,
        taskStatusChanged: input.taskStatusChanged,
      };
      const preference = await ctx.prisma.notificationPreference.upsert({
        where: {
          userId_workspaceId: {
            userId: ctx.user.id,
            workspaceId: workspace.id,
          },
        },
        create: {
          userId: ctx.user.id,
          workspaceId: workspace.id,
          ...data,
        },
        update: data,
      });
      return { preference };
    }),

  types: protectedProcedure.query(() => ({
    types: Object.values(NotificationType),
  })),
});
