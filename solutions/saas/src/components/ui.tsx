import { AlertCircle, Inbox } from "lucide-react";

export const TASK_STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
] as const;

export const STATUS_LABELS: Record<(typeof TASK_STATUSES)[number], string> = {
  BACKLOG: "待整理",
  TODO: "待开始",
  IN_PROGRESS: "进行中",
  IN_REVIEW: "待验收",
  DONE: "已完成",
  CANCELLED: "已取消",
};

export const PRIORITY_LABELS: Record<string, string> = {
  NONE: "无",
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
  URGENT: "紧急",
};

export function Avatar({
  name,
  email,
  size = "medium",
}: {
  name?: string | null;
  email?: string | null;
  size?: "small" | "medium";
}) {
  const source = name?.trim() || email?.trim() || "?";
  const initials = source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <span className={"avatar avatar-" + size} aria-hidden="true">
      {initials}
    </span>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={17} />
      <span>{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="empty-state">
      <Inbox size={24} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function ViewSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <span className="skeleton-line" key={index} />
      ))}
    </div>
  );
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
