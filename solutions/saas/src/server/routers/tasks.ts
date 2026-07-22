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
import { decodeCursor, encodeCursor } from "@/server/domain/cursor";
import { projectKeySchema } from "@/server/routers/projects";
import { realtimeEventBus } from "@/server/realtime/event-bus";
import { toRealtimeUser } from "@/server/realtime/events";
import { protectedProcedure, router } from "@/server/trpc";

const taskTitleSchema = z.string().trim().min(1).max(200);
const taskStatusSchema = z.nativeEnum(TaskStatus);
const taskPrioritySchema = z.nativeEnum(TaskPriority);
const labelColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Label color must be a hex color");
const listSortFieldSchema = z.enum(["createdAt", "updatedAt", "number"]);
const sortDirectionSchema = z.enum(["asc", "desc"]);
const listLimitSchema = z.number().int().min(1).max(100).default(30);

function calculateOrder(beforeOrder?: number, afterOrder?: number): number {
  if (beforeOrder !== undefined && afterOrder !== undefined) {
    if (beforeOrder >= afterOrder) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "beforeNumber must come before afterNumber",
      });
    }

    return (beforeOrder + afterOrder) / 2;
  }

  if (beforeOrder !== undefined) {
    return beforeOrder + 1000;
  }

  if (afterOrder !== undefined) {
    return afterOrder - 1000;
  }

  return 1000;
}

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
  board: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        assigneeId: z.string().uuid().optional(),
        priority: taskPrioritySchema.optional(),
        labelName: z.string().trim().min(1).max(40).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await requireMembership(
        ctx.prisma,
        ctx.user.id,
        input.workspaceSlug,
      );
      const project = await requireProject(ctx.prisma, workspace.id, input.projectKey);
      const baseWhere = {
        projectId: project.id,
        deletedAt: null,
        assigneeId: input.assigneeId,
        priority: input.priority,
        labels: input.labelName
          ? { some: { label: { name: input.labelName } } }
          : undefined,
      };

      const tasks = await ctx.prisma.task.findMany({
        where: baseWhere,
        orderBy: [{ status: "asc" }, { order: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          priority: true,
          assignee: {
            select: { id: true, email: true, name: true, avatarUrl: true },
          },
          dueDate: true,
          order: true,
          version: true,
          labels: {
            select: {
              label: { select: { id: true, name: true, color: true } },
            },
          },
        },
      });

      const countByStatus = new Map(
        Object.values(TaskStatus).map((status) => [
          status,
          tasks.filter((task) => task.status === status).length,
        ]),
      );
      const columns = Object.values(TaskStatus).map((status) => ({
        status,
        count: countByStatus.get(status) ?? 0,
        tasks: tasks.filter((task) => task.status === status),
      }));

      return { project, columns };
    }),

  listView: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema.optional(),
        status: taskStatusSchema.optional(),
        assigneeId: z.string().uuid().optional(),
        priority: taskPrioritySchema.optional(),
        labelName: z.string().trim().min(1).max(40).optional(),
        q: z.string().trim().min(1).max(100).optional(),
        sortField: listSortFieldSchema.default("updatedAt"),
        sortDirection: sortDirectionSchema.default("desc"),
        limit: listLimitSchema,
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
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid cursor",
        });
      }
      const sortValue = cursor?.value;
      const sortField = input.sortField;
      const sortDirection = input.sortDirection;
      const cursorWhere =
        cursor && sortValue !== undefined
          ? {
              OR:
                sortDirection === "desc"
                  ? [
                      { [sortField]: { lt: sortValue } },
                      { [sortField]: sortValue, id: { lt: cursor.id } },
                    ]
                  : [
                      { [sortField]: { gt: sortValue } },
                      { [sortField]: sortValue, id: { gt: cursor.id } },
                    ],
            }
          : undefined;

      const tasks = await ctx.prisma.task.findMany({
        where: {
          deletedAt: null,
          status: input.status,
          assigneeId: input.assigneeId,
          priority: input.priority,
          project: {
            workspaceId: workspace.id,
            deletedAt: null,
            key: input.projectKey,
          },
          labels: input.labelName
            ? { some: { label: { name: input.labelName } } }
            : undefined,
          OR: input.q
            ? [
                { title: { contains: input.q, mode: "insensitive" } },
                { description: { contains: input.q, mode: "insensitive" } },
              ]
            : undefined,
          AND: cursorWhere,
        },
        orderBy: [{ [sortField]: sortDirection }, { id: sortDirection }],
        take: input.limit + 1,
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
          dueDate: true,
          order: true,
          version: true,
          createdAt: true,
          updatedAt: true,
          project: {
            select: { id: true, key: true, name: true },
          },
          labels: {
            select: {
              label: { select: { id: true, name: true, color: true } },
            },
          },
        },
      });

      const hasMore = tasks.length > input.limit;
      const page = hasMore ? tasks.slice(0, input.limit) : tasks;
      const last = page.at(-1);
      const nextCursor = last
        ? encodeCursor({
            value:
              sortField === "number"
                ? last.number
                : last[sortField].toISOString(),
            id: last.id,
          })
        : null;

      return {
        tasks: page,
        nextCursor: hasMore ? nextCursor : null,
        hasMore,
      };
    }),

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

      realtimeEventBus.publish(workspace.id, {
        type: "task.created",
        workspaceId: workspace.id,
        actor: toRealtimeUser(ctx.user),
        task: {
          id: task.id,
          number: task.number,
          title: task.title,
          status: task.status,
          priority: task.priority,
          order: task.order,
          version: task.version,
          projectKey: project.key,
        },
        at: new Date().toISOString(),
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

      realtimeEventBus.publish(workspace.id, {
        type: "task.updated",
        workspaceId: workspace.id,
        actor: toRealtimeUser(ctx.user),
        task: {
          id: updated.id,
          number: updated.number,
          title: updated.title,
          status: updated.status,
          priority: updated.priority,
          order: updated.order,
          version: updated.version,
          projectKey: project.key,
        },
        at: new Date().toISOString(),
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

      realtimeEventBus.publish(workspace.id, {
        type: "task.moved",
        workspaceId: workspace.id,
        actor: toRealtimeUser(ctx.user),
        task: {
          id: updated.id,
          number: updated.number,
          status: updated.status,
          order: updated.order,
          version: updated.version,
          projectKey: project.key,
        },
        at: new Date().toISOString(),
      });

      return {
        task: updated,
        nextStatuses: allowedTaskStatusTransitions(updated.status),
      };
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        workspaceSlug: workspaceSlugSchema,
        projectKey: projectKeySchema,
        number: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        status: taskStatusSchema,
        beforeNumber: z.number().int().positive().nullable().optional(),
        afterNumber: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        input.beforeNumber != null &&
        input.afterNumber != null &&
        input.beforeNumber === input.afterNumber
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "beforeNumber and afterNumber cannot be the same task",
        });
      }

      if (input.number === input.beforeNumber || input.number === input.afterNumber) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A task cannot be ordered relative to itself",
        });
      }

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
          message: `Cannot move task from ${task.status} to ${input.status}`,
        });
      }

      const [beforeTask, afterTask] = await Promise.all([
        input.beforeNumber
          ? ctx.prisma.task.findFirst({
              where: {
                projectId: project.id,
                number: input.beforeNumber,
                status: input.status,
                deletedAt: null,
              },
              select: { order: true },
            })
          : Promise.resolve(null),
        input.afterNumber
          ? ctx.prisma.task.findFirst({
              where: {
                projectId: project.id,
                number: input.afterNumber,
                status: input.status,
                deletedAt: null,
              },
              select: { order: true },
            })
          : Promise.resolve(null),
      ]);

      if (input.beforeNumber && !beforeTask) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "beforeNumber must be in the target column",
        });
      }

      if (input.afterNumber && !afterTask) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "afterNumber must be in the target column",
        });
      }

      const order =
        input.beforeNumber == null && input.afterNumber == null
          ? ((await ctx.prisma.task.aggregate({
              where: {
                projectId: project.id,
                status: input.status,
                deletedAt: null,
                id: { not: task.id },
              },
              _max: { order: true },
            }))._max.order ?? 0) + 1000
          : calculateOrder(beforeTask?.order, afterTask?.order);
      const updated = await ctx.prisma.task.update({
        where: { id: task.id },
        data: {
          status: input.status,
          order,
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

      realtimeEventBus.publish(workspace.id, {
        type: "task.moved",
        workspaceId: workspace.id,
        actor: toRealtimeUser(ctx.user),
        task: {
          id: updated.id,
          number: updated.number,
          status: updated.status,
          order: updated.order,
          version: updated.version,
          projectKey: project.key,
        },
        at: new Date().toISOString(),
      });

      return { task: updated };
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

      realtimeEventBus.publish(workspace.id, {
        type: "task.deleted",
        workspaceId: workspace.id,
        actor: toRealtimeUser(ctx.user),
        task: {
          id: task.id,
          number: task.number,
          title: task.title,
          status: task.status,
          priority: task.priority,
          order: task.order,
          version: task.version + 1,
          projectKey: project.key,
        },
        at: new Date().toISOString(),
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

      realtimeEventBus.publish(workspace.id, {
        type: "comment.created",
        workspaceId: workspace.id,
        actor: toRealtimeUser(ctx.user),
        task: {
          id: task.id,
          number: task.number,
          title: task.title,
          status: task.status,
          priority: task.priority,
          order: task.order,
          version: task.version,
          projectKey: project.key,
        },
        comment: {
          id: comment.id,
          body: comment.body,
        },
        at: new Date().toISOString(),
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
