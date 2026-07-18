import { Role, TaskPriority, TaskStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  requireMembership,
  workspaceSlugSchema,
} from "@/server/auth/workspace-access";
import {
  allowedTaskStatusTransitions,
  canTransitionTaskStatus,
} from "@/server/domain/task-status";
import { projectKeySchema } from "@/server/routers/projects";
import { protectedProcedure, router } from "@/server/trpc";

const taskTitleSchema = z.string().trim().min(1).max(200);
const taskStatusSchema = z.nativeEnum(TaskStatus);
const taskPrioritySchema = z.nativeEnum(TaskPriority);
const labelColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Label color must be a hex color");

async function requireProject(
  prisma: Parameters<typeof requireMembership>[0],
  workspaceId: string,
  projectKey: string,
) {
  const project = await prisma.project.findFirst({
    where: {
      workspaceId,
      key: projectKey,
      deletedAt: null,
    },
    select: { id: true, key: true, name: true, workspaceId: true },
  });
  if (!project) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Project not found",
    });
  }

  return project;
}

async function requireTask(
  prisma: Parameters<typeof requireMembership>[0],
  projectId: string,
  number: number,
) {
  const task = await prisma.task.findFirst({
    where: {
      projectId,
      number,
      deletedAt: null,
    },
    select: {
      id: true,
      number: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      assigneeId: true,
      reporterId: true,
      dueDate: true,
      order: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!task) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Task not found",
    });
  }

  return task;
}

async function assertWorkspaceUser(
  prisma: Parameters<typeof requireMembership>[0],
  workspaceId: string,
  userId: string | null | undefined,
) {
  if (!userId) {
    return null;
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { userId: true },
  });
  if (!membership) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Assignee must be a member of this workspace",
    });
  }

  return userId;
}

export const tasksRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        status: taskStatusSchema.optional(),
        assigneeId: z.string().uuid().optional(),
        priority: taskPrioritySchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);

      const tasks = await ctx.prisma.task.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          status: input.status,
          assigneeId: input.assigneeId,
          priority: input.priority,
        },
        orderBy: [{ status: "asc" }, { order: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          number: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          assigneeId: true,
          reporterId: true,
          dueDate: true,
          order: true,
          version: true,
          createdAt: true,
          updatedAt: true,
          labels: {
            select: {
              label: { select: { id: true, name: true, color: true } },
            },
          },
        },
      });

      return { tasks };
    }),

  create: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        title: taskTitleSchema,
        description: z.string().trim().max(5000).optional(),
        status: taskStatusSchema.default(TaskStatus.BACKLOG),
        priority: taskPrioritySchema.default(TaskPriority.NONE),
        assigneeId: z.string().uuid().nullable().optional(),
        dueDate: z.coerce.date().nullable().optional(),
        labelNames: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.MEMBER,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);
      const assigneeId = await assertWorkspaceUser(
        ctx.prisma,
        workspace.id,
        input.assigneeId,
      );

      const task = await ctx.prisma.$transaction(async (tx) => {
        const counter = await tx.projectTaskCounter.update({
          where: { projectId: project.id },
          data: { nextNumber: { increment: 1 } },
          select: { nextNumber: true },
        });
        const number = counter.nextNumber - 1;

        const maxOrder = await tx.task.aggregate({
          where: { projectId: project.id, status: input.status, deletedAt: null },
          _max: { order: true },
        });

        const createdTask = await tx.task.create({
          data: {
            projectId: project.id,
            number,
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            assigneeId,
            reporterId: ctx.user.id,
            dueDate: input.dueDate,
            order: (maxOrder._max.order ?? 0) + 1000,
          },
          select: {
            id: true,
            number: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            assigneeId: true,
            reporterId: true,
            dueDate: true,
            order: true,
            version: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        for (const labelName of input.labelNames) {
          const label = await tx.label.upsert({
            where: {
              workspaceId_name: {
                workspaceId: workspace.id,
                name: labelName,
              },
            },
            update: {},
            create: {
              workspaceId: workspace.id,
              name: labelName,
            },
            select: { id: true },
          });

          await tx.taskLabel.create({
            data: {
              taskId: createdTask.id,
              labelId: label.id,
            },
          });
        }

        return createdTask;
      });

      return { task };
    }),

  get: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        number: z.number().int().positive(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);
      const task = await ctx.prisma.task.findFirst({
        where: { projectId: project.id, number: input.number, deletedAt: null },
        select: {
          id: true,
          number: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          assignee: {
            select: { id: true, email: true, name: true, avatarUrl: true },
          },
          reporter: {
            select: { id: true, email: true, name: true, avatarUrl: true },
          },
          dueDate: true,
          order: true,
          version: true,
          createdAt: true,
          updatedAt: true,
          labels: {
            select: {
              label: { select: { id: true, name: true, color: true } },
            },
          },
          comments: {
            where: { deletedAt: null },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              body: true,
              createdAt: true,
              author: {
                select: { id: true, email: true, name: true, avatarUrl: true },
              },
            },
          },
        },
      });
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }

      return { task };
    }),

  update: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        number: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        title: taskTitleSchema.optional(),
        description: z.string().trim().max(5000).nullable().optional(),
        priority: taskPrioritySchema.optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        dueDate: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.MEMBER,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);
      const task = await requireTask(ctx.prisma, project.id, input.number);
      if (task.version !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Task was updated by someone else",
        });
      }

      const assigneeId =
        input.assigneeId === undefined
          ? undefined
          : await assertWorkspaceUser(ctx.prisma, workspace.id, input.assigneeId);

      const updated = await ctx.prisma.task.update({
        where: { id: task.id },
        data: {
          title: input.title,
          description: input.description,
          priority: input.priority,
          assigneeId,
          dueDate: input.dueDate,
          version: { increment: 1 },
        },
        select: {
          id: true,
          number: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          assigneeId: true,
          dueDate: true,
          order: true,
          version: true,
          updatedAt: true,
        },
      });

      return { task: updated };
    }),

  transition: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        number: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        status: taskStatusSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.MEMBER,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);
      const task = await requireTask(ctx.prisma, project.id, input.number);
      if (task.version !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Task was updated by someone else",
        });
      }

      if (!canTransitionTaskStatus(task.status, input.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot transition task from ${task.status} to ${input.status}`,
        });
      }

      const maxOrder = await ctx.prisma.task.aggregate({
        where: { projectId: project.id, status: input.status, deletedAt: null },
        _max: { order: true },
      });

      const updated = await ctx.prisma.task.update({
        where: { id: task.id },
        data: {
          status: input.status,
          order: task.status === input.status ? task.order : (maxOrder._max.order ?? 0) + 1000,
          version: { increment: 1 },
        },
        select: {
          id: true,
          number: true,
          status: true,
          order: true,
          version: true,
          updatedAt: true,
        },
      });

      return {
        task: updated,
        nextStatuses: allowedTaskStatusTransitions(updated.status),
      };
    }),

  delete: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        number: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace, membership } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.MEMBER,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);
      const task = await requireTask(ctx.prisma, project.id, input.number);
      if (membership.role !== Role.ADMIN && membership.role !== Role.OWNER) {
        if (task.assigneeId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only admins or the assignee can delete this task",
          });
        }
      }

      await ctx.prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });

      return { ok: true };
    }),

  addComment: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        number: z.number().int().positive(),
        body: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.MEMBER,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);
      const task = await requireTask(ctx.prisma, project.id, input.number);

      const comment = await ctx.prisma.comment.create({
        data: {
          taskId: task.id,
          authorId: ctx.user.id,
          body: input.body,
        },
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: {
            select: { id: true, email: true, name: true, avatarUrl: true },
          },
        },
      });

      return { comment };
    }),

  upsertLabel: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        name: z.string().trim().min(1).max(40),
        color: labelColorSchema.default("#6b7280"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
        Role.MEMBER,
      );

      const label = await ctx.prisma.label.upsert({
        where: {
          workspaceId_name: {
            workspaceId: workspace.id,
            name: input.name,
          },
        },
        update: { color: input.color },
        create: {
          workspaceId: workspace.id,
          name: input.name,
          color: input.color,
        },
        select: { id: true, name: true, color: true },
      });

      return { label };
    }),
});
