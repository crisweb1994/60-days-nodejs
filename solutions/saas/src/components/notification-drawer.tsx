"use client";

import { Bell, CheckCheck, X } from "lucide-react";

import { EmptyState, ErrorBanner, ViewSkeleton } from "@/components/ui";
import { trpc } from "@/trpc/react";

export function NotificationDrawer({
  open,
  onClose,
  workspaceSlug,
}: {
  open: boolean;
  onClose: () => void;
  workspaceSlug: string;
}) {
  const utils = trpc.useUtils();
  const notifications = trpc.notifications.list.useQuery(
    { workspaceSlug, unreadOnly: false, limit: 30 },
    { enabled: open && Boolean(workspaceSlug) },
  );
  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.notifications.list.invalidate(),
        utils.notifications.unreadCount.invalidate(),
      ]);
    },
  });
  const markAll = trpc.notifications.markAllRead.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.notifications.list.invalidate(),
        utils.notifications.unreadCount.invalidate(),
      ]);
    },
  });

  if (!open) return null;

  return (
    <>
      <button
        aria-label="关闭通知"
        className="drawer-scrim"
        onClick={onClose}
        type="button"
      />
      <aside className="notification-drawer" aria-label="通知">
        <header>
          <div>
            <Bell size={18} />
            <h2>通知</h2>
          </div>
          <div>
            <button
              aria-label="全部标为已读"
              className="icon-button"
              disabled={markAll.isLoading}
              onClick={() => markAll.mutate({ workspaceSlug })}
              title="全部标为已读"
              type="button"
            >
              <CheckCheck size={18} />
            </button>
            <button
              aria-label="关闭"
              className="icon-button"
              onClick={onClose}
              type="button"
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="notification-list">
          {notifications.isLoading ? <ViewSkeleton rows={5} /> : null}
          {notifications.error ? (
            <ErrorBanner message={notifications.error.message} />
          ) : null}
          {notifications.data?.notifications.length === 0 ? (
            <EmptyState
              detail="任务指派、评论和状态变化会出现在这里。"
              title="暂时没有通知"
            />
          ) : null}
          {notifications.data?.notifications.map((notification) => (
            <button
              className={
                "notification-item " +
                (notification.readAt ? "" : "is-unread")
              }
              key={notification.id}
              onClick={() => {
                if (!notification.readAt) {
                  markRead.mutate({
                    workspaceSlug,
                    notificationId: notification.id,
                  });
                }
              }}
              type="button"
            >
              <span className="notification-state" />
              <span>
                <strong>{notification.title}</strong>
                {notification.body ? <p>{notification.body}</p> : null}
                <small>
                  {new Intl.DateTimeFormat("zh-CN", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(notification.createdAt))}
                </small>
              </span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
