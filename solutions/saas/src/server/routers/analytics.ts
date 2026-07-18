import { Prisma, type PrismaClient, TaskStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  requireMembership,
  workspaceSlugSchema,
} from "@/server/auth/workspace-access";
import { projectKeySchema } from "@/server/routers/projects";
import { protectedProcedure, router } from "@/server/trpc";

const scopeSchema = z.object({
  workspaceSlug: workspaceSlugSchema,
  projectKey: projectKeySchema.optional(),
});
const periodSchema = scopeSchema.extend({
  days: z.number().int().min(7).max(90).default(30),
});

async function resolveScope(
  prisma: PrismaClient,
  userId: string,
  input: z.infer<typeof scopeSchema>,
) {
  const { workspace } = await requireMembership(
    prisma,
    userId,
    input.workspaceSlug,
  );
  if (!input.projectKey) {
    return { workspace, projectId: null };
  }

  const project = await prisma.project.findFirst({
    where: {
      workspaceId: workspace.id,
      key: input.projectKey,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!project) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Project not found",
    });
  }

  return { workspace, projectId: project.id };
}

function projectFilter(projectId: string | null): Prisma.Sql {
  return projectId
    ? Prisma.sql`AND p.id = ${projectId}::uuid`
    : Prisma.empty;
}

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10;
}

type OverviewRow = {
  projectCount: number;
  total: number;
  backlog: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
  cancelled: number;
  overdue: number;
  unassigned: number;
  completedInPeriod: number;
};

type TrendRow = {
  date: string;
  completed: number;
};

type WorkloadRow = {
  userId: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: string | null;
  total: number;
  done: number;
  inProgress: number;
  overdue: number;
};

type ProjectProgressRow = {
  id: string;
  key: string;
  name: string;
  archivedAt: Date | null;
  total: number;
  backlog: number;
  done: number;
  active: number;
  cancelled: number;
  overdue: number;
};

export const analyticsRouter = router({
  overview: protectedProcedure
    .input(periodSchema)
    .query(async ({ ctx, input }) => {
      const { workspace, projectId } = await resolveScope(
        ctx.prisma,
        ctx.user.id,
        input,
      );
      const [row] = await ctx.prisma.$queryRaw<OverviewRow[]>(Prisma.sql`
        WITH scoped_projects AS (
          SELECT p.id
          FROM projects p
          WHERE p.workspace_id = ${workspace.id}::uuid
            AND p.deleted_at IS NULL
            ${projectFilter(projectId)}
        )
        SELECT
          (SELECT COUNT(*)::int FROM scoped_projects) AS "projectCount",
          COUNT(t.id)::int AS total,
          (COUNT(t.id) FILTER (WHERE t.status = 'BACKLOG'))::int AS backlog,
          (COUNT(t.id) FILTER (WHERE t.status = 'TODO'))::int AS todo,
          (COUNT(t.id) FILTER (WHERE t.status = 'IN_PROGRESS'))::int AS "inProgress",
          (COUNT(t.id) FILTER (WHERE t.status = 'IN_REVIEW'))::int AS "inReview",
          (COUNT(t.id) FILTER (WHERE t.status = 'DONE'))::int AS done,
          (COUNT(t.id) FILTER (WHERE t.status = 'CANCELLED'))::int AS cancelled,
          (
            COUNT(t.id) FILTER (
              WHERE t.due_date < now()
                AND t.status NOT IN ('DONE', 'CANCELLED')
            )
          )::int AS overdue,
          (COUNT(t.id) FILTER (WHERE t.assignee_id IS NULL))::int AS unassigned,
          (
            COUNT(t.id) FILTER (
              WHERE t.completed_at >=
                (timezone('UTC', now())::date - ${input.days - 1}::int)
                  ::timestamp AT TIME ZONE 'UTC'
                AND t.completed_at <
                  (timezone('UTC', now())::date + 1)
                    ::timestamp AT TIME ZONE 'UTC'
            )
          )::int AS "completedInPeriod"
        FROM scoped_projects p
        LEFT JOIN tasks t
          ON t.project_id = p.id
         AND t.deleted_at IS NULL
      `);
      const overview = row ?? {
        projectCount: 0,
        total: 0,
        backlog: 0,
        todo: 0,
        inProgress: 0,
        inReview: 0,
        done: 0,
        cancelled: 0,
        overdue: 0,
        unassigned: 0,
        completedInPeriod: 0,
      };
      const actionableTotal = overview.total - overview.cancelled;

      return {
        ...overview,
        periodDays: input.days,
        completionRate: percentage(overview.done, actionableTotal),
        statusDistribution: [
          { status: TaskStatus.BACKLOG, count: overview.backlog },
          { status: TaskStatus.TODO, count: overview.todo },
          { status: TaskStatus.IN_PROGRESS, count: overview.inProgress },
          { status: TaskStatus.IN_REVIEW, count: overview.inReview },
          { status: TaskStatus.DONE, count: overview.done },
          { status: TaskStatus.CANCELLED, count: overview.cancelled },
        ],
      };
    }),

  completionTrend: protectedProcedure
    .input(periodSchema)
    .query(async ({ ctx, input }) => {
      const { workspace, projectId } = await resolveScope(
        ctx.prisma,
        ctx.user.id,
        input,
      );
      const rows = await ctx.prisma.$queryRaw<TrendRow[]>(Prisma.sql`
        WITH days AS (
          SELECT generate_series(
            timezone('UTC', now())::date - ${input.days - 1}::int,
            timezone('UTC', now())::date,
            interval '1 day'
          )::date AS day
        ),
        completed_tasks AS (
          SELECT t.completed_at
          FROM tasks t
          INNER JOIN projects p ON p.id = t.project_id
          WHERE p.workspace_id = ${workspace.id}::uuid
            AND p.deleted_at IS NULL
            AND t.deleted_at IS NULL
            AND t.completed_at IS NOT NULL
            AND t.completed_at >=
              (timezone('UTC', now())::date - ${input.days - 1}::int)
                ::timestamp AT TIME ZONE 'UTC'
            ${projectFilter(projectId)}
        )
        SELECT
          to_char(days.day, 'YYYY-MM-DD') AS date,
          COUNT(completed_tasks.completed_at)::int AS completed
        FROM days
        LEFT JOIN completed_tasks
          ON completed_tasks.completed_at >=
               days.day::timestamp AT TIME ZONE 'UTC'
         AND completed_tasks.completed_at <
               (days.day + 1)::timestamp AT TIME ZONE 'UTC'
        GROUP BY days.day
        ORDER BY days.day ASC
      `);
      let cumulative = 0;

      return {
        timezone: "UTC",
        days: rows.map((row) => {
          cumulative += row.completed;
          return { ...row, cumulative };
        }),
      };
    }),

  workload: protectedProcedure
    .input(scopeSchema)
    .query(async ({ ctx, input }) => {
      const { workspace, projectId } = await resolveScope(
        ctx.prisma,
        ctx.user.id,
        input,
      );
      const rows = await ctx.prisma.$queryRaw<WorkloadRow[]>(Prisma.sql`
        WITH task_stats AS (
          SELECT
            t.assignee_id,
            COUNT(t.id)::int AS total,
            (COUNT(t.id) FILTER (WHERE t.status = 'DONE'))::int AS done,
            (
              COUNT(t.id) FILTER (
                WHERE t.status IN ('IN_PROGRESS', 'IN_REVIEW')
              )
            )::int AS "inProgress",
            (
              COUNT(t.id) FILTER (
                WHERE t.due_date < now()
                  AND t.status NOT IN ('DONE', 'CANCELLED')
              )
            )::int AS overdue
          FROM tasks t
          INNER JOIN projects p ON p.id = t.project_id
          WHERE p.workspace_id = ${workspace.id}::uuid
            AND p.deleted_at IS NULL
            AND t.deleted_at IS NULL
            ${projectFilter(projectId)}
          GROUP BY t.assignee_id
        ),
        members AS (
          SELECT
            m.user_id,
            m.role::text AS role,
            u.name,
            u.email,
            u.avatar_url
          FROM memberships m
          INNER JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ${workspace.id}::uuid
        )
        SELECT
          members.user_id AS "userId",
          members.name,
          members.email,
          members.avatar_url AS "avatarUrl",
          members.role,
          COALESCE(task_stats.total, 0)::int AS total,
          COALESCE(task_stats.done, 0)::int AS done,
          COALESCE(task_stats."inProgress", 0)::int AS "inProgress",
          COALESCE(task_stats.overdue, 0)::int AS overdue
        FROM members
        LEFT JOIN task_stats ON task_stats.assignee_id = members.user_id

        UNION ALL

        SELECT
          NULL::uuid AS "userId",
          'Unassigned'::text AS name,
          NULL::text AS email,
          NULL::text AS "avatarUrl",
          NULL::text AS role,
          task_stats.total,
          task_stats.done,
          task_stats."inProgress",
          task_stats.overdue
        FROM task_stats
        WHERE task_stats.assignee_id IS NULL

        UNION ALL

        SELECT
          task_stats.assignee_id AS "userId",
          users.name,
          users.email,
          users.avatar_url AS "avatarUrl",
          NULL::text AS role,
          task_stats.total,
          task_stats.done,
          task_stats."inProgress",
          task_stats.overdue
        FROM task_stats
        INNER JOIN users ON users.id = task_stats.assignee_id
        LEFT JOIN members ON members.user_id = task_stats.assignee_id
        WHERE task_stats.assignee_id IS NOT NULL
          AND members.user_id IS NULL

        ORDER BY total DESC, email ASC NULLS LAST
      `);
      const totalTasks = rows.reduce((sum, row) => sum + row.total, 0);

      return {
        totalTasks,
        members: rows.map((row) => ({
          ...row,
          sharePercent: percentage(row.total, totalTasks),
          completionRate: percentage(row.done, row.total),
        })),
      };
    }),

  projectProgress: protectedProcedure
    .input(scopeSchema)
    .query(async ({ ctx, input }) => {
      const { workspace, projectId } = await resolveScope(
        ctx.prisma,
        ctx.user.id,
        input,
      );
      const rows = await ctx.prisma.$queryRaw<ProjectProgressRow[]>(Prisma.sql`
        SELECT
          p.id,
          p.key,
          p.name,
          p.archived_at AS "archivedAt",
          COUNT(t.id)::int AS total,
          (COUNT(t.id) FILTER (WHERE t.status = 'BACKLOG'))::int AS backlog,
          (COUNT(t.id) FILTER (WHERE t.status = 'DONE'))::int AS done,
          (
            COUNT(t.id) FILTER (
              WHERE t.status IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW')
            )
          )::int AS active,
          (COUNT(t.id) FILTER (WHERE t.status = 'CANCELLED'))::int AS cancelled,
          (
            COUNT(t.id) FILTER (
              WHERE t.due_date < now()
                AND t.status NOT IN ('DONE', 'CANCELLED')
            )
          )::int AS overdue
        FROM projects p
        LEFT JOIN tasks t
          ON t.project_id = p.id
         AND t.deleted_at IS NULL
        WHERE p.workspace_id = ${workspace.id}::uuid
          AND p.deleted_at IS NULL
          ${projectFilter(projectId)}
        GROUP BY p.id
        ORDER BY p.archived_at ASC NULLS FIRST, p.created_at ASC
      `);

      return {
        projects: rows.map((row) => {
          const actionableTotal = row.total - row.cancelled;
          return {
            ...row,
            completionRate: percentage(row.done, actionableTotal),
          };
        }),
      };
    }),
});
