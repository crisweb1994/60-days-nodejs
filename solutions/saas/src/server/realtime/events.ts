import type { TaskPriority, TaskStatus } from "@prisma/client";

export type RealtimeUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type TaskRealtimePayload = {
  id: string;
  number: number;
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  order?: number;
  version?: number;
  projectKey: string;
};

export type RealtimeEvent =
  | {
      type: "presence.snapshot";
      workspaceId: string;
      users: RealtimeUser[];
      at: string;
    }
  | {
      type: "presence.joined" | "presence.left";
      workspaceId: string;
      user: RealtimeUser;
      at: string;
    }
  | {
      type:
        | "task.created"
        | "task.updated"
        | "task.moved"
        | "task.deleted";
      workspaceId: string;
      actor: RealtimeUser;
      task: TaskRealtimePayload;
      at: string;
    }
  | {
      type: "comment.created";
      workspaceId: string;
      actor: RealtimeUser;
      task: TaskRealtimePayload;
      comment: {
        id: string;
        body: string;
      };
      at: string;
    }
  | {
      type: "ping";
      at: string;
    };

export function toRealtimeUser(user: RealtimeUser): RealtimeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}
