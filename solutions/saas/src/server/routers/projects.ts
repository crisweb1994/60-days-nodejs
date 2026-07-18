import { Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  requireMembership,
  workspaceSlugSchema,
} from "@/server/auth/workspace-access";
import { protectedProcedure, router } from "@/server/trpc";

const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,5}$/, {
    message: "Project key must be 2-6 uppercase letters or numbers",
  });

const projectNameSchema = z.string().trim().min(1).max(100);

export const projectsRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceSlug: workspaceSlugSchema }))
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );

      const projects = await ctx.prisma.project.findMany({
        where: {
          workspaceId: workspace.id,
          deletedAt: null,
        },
        orderBy: [{ archivedAt: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          icon: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return { projects };
    }),

  create: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        key: projectKeySchema,
        name: projectNameSchema,
        description: z.string().trim().max(2000).optional(),
        icon: z.string().trim().max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.ADMIN,
      );

      try {
        const project = await ctx.prisma.$transaction(async (tx) => {
          const createdProject = await tx.project.create({
            data: {
              workspaceId: workspace.id,
              key: input.key,
              name: input.name,
              description: input.description,
              icon: input.icon,
            },
            select: {
              id: true,
              key: true,
              name: true,
              description: true,
              icon: true,
              archivedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          });

          await tx.projectTaskCounter.create({
            data: {
              projectId: createdProject.id,
            },
          });

          return createdProject;
        });

        return { project };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2002"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Project key is already used in this workspace",
          });
        }

        throw error;
      }
    }),

  get: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        key: projectKeySchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );

      const project = await ctx.prisma.project.findFirst({
        where: {
          workspaceId: workspace.id,
          key: input.key,
          deletedAt: null,
        },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          icon: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      return { project };
    }),

  update: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        key: projectKeySchema,
        name: projectNameSchema.optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        icon: z.string().trim().max(20).nullable().optional(),
        archived: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.ADMIN,
      );

      const project = await ctx.prisma.project.findFirst({
        where: { workspaceId: workspace.id, key: input.key, deletedAt: null },
        select: { id: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const updatedProject = await ctx.prisma.project.update({
        where: { id: project.id },
        data: {
          name: input.name,
          description: input.description,
          icon: input.icon,
          archivedAt:
            input.archived === undefined
              ? undefined
              : input.archived
                ? new Date()
                : null,
        },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          icon: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return { project: updatedProject };
    }),

  delete: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        key: projectKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.ADMIN,
      );

      const project = await ctx.prisma.project.findFirst({
        where: { workspaceId: workspace.id, key: input.key, deletedAt: null },
        select: { id: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      await ctx.prisma.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });

      return { ok: true };
    }),
});

export { projectKeySchema };
