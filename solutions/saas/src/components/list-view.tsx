"use client";

import {
  CalendarDays,
  ChevronDown,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

import {
  Avatar,
  EmptyState,
  ErrorBanner,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_STATUSES,
  ViewSkeleton,
  formatDate,
} from "@/components/ui";
import { trpc } from "@/trpc/react";

type TaskStatus = (typeof TASK_STATUSES)[number];

export function ListView({
  workspaceSlug,
  projectKey,
}: {
  workspaceSlug: string;
  projectKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [priority, setPriority] = useState<
    "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT" | ""
  >("");
  const tasks = trpc.tasks.listView.useInfiniteQuery(
    {
      workspaceSlug,
      projectKey,
      q: query || undefined,
      status: status || undefined,
      priority: priority || undefined,
      sortField: "updatedAt",
      sortDirection: "desc",
      limit: 30,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      keepPreviousData: true,
    },
  );
  const rows = useMemo(
    () => tasks.data?.pages.flatMap((page) => page.tasks) ?? [],
    [tasks.data],
  );

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setQuery(String(data.get("query") ?? "").trim());
  }

  return (
    <div className="list-view">
      <div className="list-toolbar">
        <form className="search-control" onSubmit={search}>
          <Search size={16} aria-hidden="true" />
          <input
            defaultValue={query}
            name="query"
            placeholder="搜索标题或描述"
            type="search"
          />
          <button type="submit">搜索</button>
        </form>
        <div className="filter-control">
          <SlidersHorizontal size={15} aria-hidden="true" />
          <select
            aria-label="按状态筛选"
            onChange={(event) => setStatus(event.target.value as TaskStatus | "")}
            value={status}
          >
            <option value="">全部状态</option>
            {TASK_STATUSES.map((item) => (
              <option key={item} value={item}>
                {STATUS_LABELS[item]}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
        <div className="filter-control">
          <select
            aria-label="按优先级筛选"
            onChange={(event) =>
              setPriority(
                event.target.value as
                  | "NONE"
                  | "LOW"
                  | "MEDIUM"
                  | "HIGH"
                  | "URGENT"
                  | "",
              )
            }
            value={priority}
          >
            <option value="">全部优先级</option>
            {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
      </div>

      {tasks.error ? <ErrorBanner message={tasks.error.message} /> : null}
      {tasks.isLoading ? <ViewSkeleton rows={7} /> : null}

      {!tasks.isLoading && rows.length === 0 ? (
        <EmptyState
          detail={
            query || status || priority
              ? "调整筛选条件，查看其他任务。"
              : "从看板创建第一条任务。"
          }
          title={query || status || priority ? "没有匹配的任务" : "列表为空"}
        />
      ) : null}

      {rows.length > 0 ? (
        <div className="task-table-wrap">
          <table className="task-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>优先级</th>
                <th>负责人</th>
                <th>截止日期</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <tr key={task.id}>
                  <td>
                    <span className="table-task">
                      <small>
                        {task.project.key}-{task.number}
                      </small>
                      <strong>{task.title}</strong>
                      {task.labels.length > 0 ? (
                        <span className="table-labels">
                          {task.labels.slice(0, 2).map(({ label }) => (
                            <i
                              key={label.id}
                              style={{ backgroundColor: label.color }}
                              title={label.name}
                            />
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        "status-badge status-bg-" +
                        task.status.toLowerCase()
                      }
                    >
                      {STATUS_LABELS[task.status]}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        "priority priority-" + task.priority.toLowerCase()
                      }
                    >
                      {PRIORITY_LABELS[task.priority]}
                    </span>
                  </td>
                  <td>
                    <span className="table-assignee">
                      <Avatar
                        email={task.assignee?.email}
                        name={task.assignee?.name}
                        size="small"
                      />
                      {task.assignee?.name ??
                        task.assignee?.email ??
                        "未分配"}
                    </span>
                  </td>
                  <td>
                    <span className={isOverdue(task.dueDate, task.status) ? "is-overdue" : ""}>
                      {task.dueDate ? <CalendarDays size={13} /> : null}
                      {formatDate(task.dueDate)}
                    </span>
                  </td>
                  <td>{formatDate(task.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tasks.hasNextPage ? (
        <button
          className="secondary-button load-more"
          disabled={tasks.isFetchingNextPage}
          onClick={() => tasks.fetchNextPage()}
          type="button"
        >
          {tasks.isFetchingNextPage ? "加载中…" : "加载更多"}
        </button>
      ) : null}
    </div>
  );
}

function isOverdue(
  dueDate: Date | string | null,
  status: string,
): boolean {
  if (!dueDate || status === "DONE" || status === "CANCELLED") return false;
  return new Date(dueDate).getTime() < Date.now();
}
