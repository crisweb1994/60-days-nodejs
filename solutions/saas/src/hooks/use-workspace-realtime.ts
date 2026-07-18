"use client";

import { useEffect } from "react";

import { trpc } from "@/trpc/react";

const TASK_EVENTS = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.deleted",
  "comment.created",
] as const;

export function useWorkspaceRealtime(workspaceSlug: string) {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!workspaceSlug) return;
    const source = new EventSource(
      "/api/realtime/workspaces/" +
        encodeURIComponent(workspaceSlug) +
        "/events",
    );
    const refresh = () => {
      void Promise.all([
        utils.tasks.board.invalidate(),
        utils.tasks.listView.invalidate(),
        utils.analytics.overview.invalidate(),
        utils.analytics.completionTrend.invalidate(),
        utils.analytics.workload.invalidate(),
        utils.analytics.projectProgress.invalidate(),
      ]);
    };

    for (const eventName of TASK_EVENTS) {
      source.addEventListener(eventName, refresh);
    }

    return () => {
      for (const eventName of TASK_EVENTS) {
        source.removeEventListener(eventName, refresh);
      }
      source.close();
    };
  }, [utils, workspaceSlug]);
}
