import { TaskStatus } from "@prisma/client";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: [TaskStatus.TODO, TaskStatus.CANCELLED],
  TODO: [TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
  IN_PROGRESS: [TaskStatus.IN_REVIEW, TaskStatus.TODO, TaskStatus.CANCELLED],
  IN_REVIEW: [TaskStatus.DONE, TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
  DONE: [TaskStatus.IN_REVIEW],
  CANCELLED: [TaskStatus.BACKLOG],
};

export function canTransitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function allowedTaskStatusTransitions(from: TaskStatus): TaskStatus[] {
  return TRANSITIONS[from];
}
