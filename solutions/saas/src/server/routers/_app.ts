import { authRouter } from "@/server/routers/auth";
import { healthRouter } from "@/server/routers/health";
import { notificationsRouter } from "@/server/routers/notifications";
import { projectsRouter } from "@/server/routers/projects";
import { tasksRouter } from "@/server/routers/tasks";
import { workspacesRouter } from "@/server/routers/workspaces";
import { router } from "@/server/trpc";

export const appRouter = router({
  auth: authRouter,
  health: healthRouter,
  notifications: notificationsRouter,
  projects: projectsRouter,
  tasks: tasksRouter,
  workspaces: workspacesRouter,
});

export type AppRouter = typeof appRouter;
