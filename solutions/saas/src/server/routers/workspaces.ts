import { randomBytes } from "node:crypto";

import { Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  requireMembership,
  workspaceNameSchema,
  workspaceSlugSchema,
} from "@/server/auth/workspace-access";
import { protectedProcedure, router } from "@/server/trpc";

const roleSchema = z.nativeEnum(Role);
const inviteRoleSchema = z.enum(["ADMIN", "MEMBER", "VIEWER"]);

export const workspacesRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: workspaceNameSchema,
        slug: workspaceSlugSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const workspace = await ctx.prisma.workspace.create({
          data: {
            name: input.name,
            slug: input.slug,
            memberships: {
              create: {
                userId: ctx.user.id,
                role: Role.OWNER,
              },
            },
          },
          select: { id: true, name: true, slug: true, avatarUrl: true },
        });

        return { workspace };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2002"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Workspace slug is already taken",
          });
        }

        throw error;
      }
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.prisma.membership.findMany({
      where: { userId: ctx.user.id },
      orderBy: { joinedAt: "asc" },
      select: {
        role: true,
        joinedAt: true,
        workspace: {
          select: { id: true, name: true, slug: true, avatarUrl: true },
        },
      },
    });

    return { memberships };
  }),

  get: protectedProcedure
    .input(z.object({ slug: workspaceSlugSchema }))
    .query(async ({ ctx, input }) => {
      const { workspace, membership } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.slug,
      );

      return { workspace, membership };
    }),

  update: protectedProcedure
    .input(
      z.object({
        slug: workspaceSlugSchema,
        name: workspaceNameSchema.optional(),
        avatarUrl: z.string().url().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.slug,
        Role.ADMIN,
      );

      const updatedWorkspace = await ctx.prisma.workspace.update({
        where: { id: workspace.id },
        data: {
          name: input.name,
          avatarUrl: input.avatarUrl,
        },
        select: { id: true, name: true, slug: true, avatarUrl: true },
      });

      return { workspace: updatedWorkspace };
    }),

  members: protectedProcedure
    .input(z.object({ slug: workspaceSlugSchema }))
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(ctx.prisma, ctx.user.id, input.slug);

      const members = await ctx.prisma.membership.findMany({
        where: { workspaceId: workspace.id },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
        select: {
          id: true,
          role: true,
          joinedAt: true,
          user: {
            select: { id: true, email: true, name: true, avatarUrl: true },
          },
        },
      });

      return { members };
    }),

  updateMemberRole: protectedProcedure
    .input(
      z.object({
        slug: workspaceSlugSchema,
        userId: z.string().uuid(),
        role: roleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace, membership } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.slug,
        Role.OWNER,
      );

      if (input.userId === ctx.user.id && membership.role === Role.OWNER) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Owners cannot change their own role",
        });
      }

      const targetMembership = await ctx.prisma.membership.findUnique({
        where: {
          userId_workspaceId: {
            userId: input.userId,
            workspaceId: workspace.id,
          },
        },
        select: { id: true, role: true },
      });
      if (!targetMembership) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace member not found",
        });
      }

      if (targetMembership.role === Role.OWNER && input.role !== Role.OWNER) {
        const ownerCount = await ctx.prisma.membership.count({
          where: { workspaceId: workspace.id, role: Role.OWNER },
        });
        if (ownerCount <= 1) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Workspace must keep at least one owner",
          });
        }
      }

      const updatedMembership = await ctx.prisma.membership.update({
        where: { id: targetMembership.id },
        data: { role: input.role },
        select: { id: true, role: true, userId: true, workspaceId: true },
      });

      return { membership: updatedMembership };
    }),

  invite: protectedProcedure
    .input(
      z.object({
        slug: workspaceSlugSchema,
        email: z.string().trim().email().max(255).toLowerCase(),
        role: inviteRoleSchema.default("MEMBER"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.slug,
        Role.ADMIN,
      );
      const token = randomBytes(32).toString("hex");

      const invitation = await ctx.prisma.invitation.create({
        data: {
          workspaceId: workspace.id,
          email: input.email,
          role: input.role,
          token,
          invitedById: ctx.user.id,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
        },
        select: {
          id: true,
          email: true,
          role: true,
          token: true,
          expiresAt: true,
        },
      });

      return { invitation };
    }),

  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string().length(64) }))
    .mutation(async ({ ctx, input }) => {
      const invitation = await ctx.prisma.invitation.findUnique({
        where: { token: input.token },
        select: {
          id: true,
          email: true,
          role: true,
          workspaceId: true,
          expiresAt: true,
          acceptedAt: true,
          workspace: {
            select: { id: true, slug: true, name: true, avatarUrl: true },
          },
        },
      });

      if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invitation is invalid or expired",
        });
      }

      if (invitation.email !== ctx.user.email) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invitation belongs to another email",
        });
      }

      const membership = await ctx.prisma.$transaction(async (tx) => {
        const membershipRecord = await tx.membership.upsert({
          where: {
            userId_workspaceId: {
              userId: ctx.user.id,
              workspaceId: invitation.workspaceId,
            },
          },
          update: {},
          create: {
            userId: ctx.user.id,
            workspaceId: invitation.workspaceId,
            role: invitation.role,
          },
          select: { id: true, role: true, joinedAt: true },
        });

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        });

        return membershipRecord;
      });

      return {
        workspace: invitation.workspace,
        membership,
      };
    }),
});
