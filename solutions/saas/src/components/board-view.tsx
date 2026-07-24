"use client";

import {
  CalendarDays,
  GripVertical,
  Plus,
  UserRound,
  X,
} from "lucide-react";
import { FormEvent, useState } from "react";

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

const allowedTransitions: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: ["BACKLOG", "TODO", "CANCELLED"],
  TODO: ["TODO", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["IN_PROGRESS", "IN_REVIEW", "TODO", "CANCELLED"],
  IN_REVIEW: ["IN_REVIEW", "DONE", "IN_PROGRESS", "CANCELLED"],
  DONE: ["DONE", "IN_REVIEW"],
  CANCELLED: ["CANCELLED", "BACKLOG"],
};

type DraggedTask = {
  number: number;
  status: TaskStatus;
  version: number;
};

export function BoardView({
  workspaceSlug,
  projectKey,
}: {
  workspaceSlug: string;
  projectKey: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [dragged, setDragged] = useState<DraggedTask | null>(null);
  const [interactionError, setInteractionError] = useState("");
  const utils = trpc.useUtils();
  const board = trpc.tasks.board.useQuery({ workspaceSlug, projectKey });
  const members = trpc.workspaces.members.useQuery({ slug: workspaceSlug });
  const reorder = trpc.tasks.reorder.useMutation({
    onSuccess: invalidateTaskViews,
  });
  const create = trpc.tasks.create.useMutation({
    onSuccess: async () => {
      setCreateOpen(false);
      await invalidateTaskViews();
    },
  });

  async function invalidateTaskViews() {
    await Promise.all([
      utils.tasks.board.invalidate(),
      utils.tasks.listView.invalidate(),
      utils.analytics.overview.invalidate(),
      utils.analytics.completionTrend.invalidate(),
      utils.analytics.workload.invalidate(),
      utils.analytics.projectProgress.invalidate(),
    ]);
  }

  function moveTask(task: DraggedTask, status: TaskStatus) {
    setInteractionError("");
    if (!allowedTransitions[task.status].includes(status)) {
      setInteractionError(
        STATUS_LABELS[task.status] +
          "不能直接移动到" +
          STATUS_LABELS[status] +
          "。",
      );
      return;
    }
    reorder.mutate({
      workspaceSlug,
      projectKey,
      number: task.number,
      expectedVersion: task.version,
      status,
      beforeNumber: null,
      afterNumber: null,
    });
  }

  function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const assigneeId = String(data.get("assigneeId") ?? "");
    const dueDate = String(data.get("dueDate") ?? "");
    create.mutate(
      {
        workspaceSlug,
        projectKey,
        title: String(data.get("title") ?? ""),
        priority: String(data.get("priority") ?? "NONE") as
          | "NONE"
          | "LOW"
          | "MEDIUM"
          | "HIGH"
          | "URGENT",
        assigneeId: assigneeId || null,
        dueDate: dueDate ? new Date(dueDate + "T12:00:00") : null,
        status: "TODO",
        labelNames: [],
      },
      { onSuccess: () => form.reset() },
    );
  }

  if (board.isLoading) return <ViewSkeleton rows={6} />;
  if (board.error) return <ErrorBanner message={board.error.message} />;

  return (
    <div className="board-view">
      <div className="view-toolbar board-toolbar">
        <div>
          <strong>{board.data?.project.name}</strong>
          <span>{board.data?.columns.reduce((sum, col) => sum + col.count, 0)} 个任务</span>
        </div>
        <button
          className={createOpen ? "secondary-button" : "primary-button"}
          onClick={() => setCreateOpen((value) => !value)}
          type="button"
        >
          {createOpen ? <X size={16} /> : <Plus size={16} />}
          {createOpen ? "取消" : "新建任务"}
        </button>
      </div>

      {createOpen ? (
        <form className="task-create-form" onSubmit={submitTask}>
          <label className="field task-title-field">
            <span>任务标题</span>
            <input
              autoFocus
              maxLength={200}
              name="title"
              placeholder="需要完成什么？"
              required
            />
          </label>
          <label className="field compact-field">
            <span>负责人</span>
            <select name="assigneeId">
              <option value="">未分配</option>
              {members.data?.members.map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {member.user.name ?? member.user.email}
                </option>
              ))}
            </select>
          </label>
          <label className="field compact-field">
            <span>优先级</span>
            <select defaultValue="NONE" name="priority">
              {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field compact-field">
            <span>截止日期</span>
            <input name="dueDate" type="date" />
          </label>
          <button
            className="primary-button create-task-submit"
            disabled={create.isLoading}
            type="submit"
          >
            {create.isLoading ? "创建中…" : "添加任务"}
          </button>
        </form>
      ) : null}

      {interactionError || reorder.error || create.error ? (
        <ErrorBanner
          message={
            interactionError ||
            reorder.error?.message ||
            create.error?.message ||
            "操作失败"
          }
        />
      ) : null}

      <div className="board-columns">
        {board.data?.columns.map((column) => {
          const status = column.status as TaskStatus;
          const canDrop =
            dragged === null || allowedTransitions[dragged.status].includes(status);
          return (
            <section
              className={
                "board-column " +
                (dragged && canDrop ? "can-drop " : "") +
                (dragged && !canDrop ? "cannot-drop" : "")
              }
              key={column.status}
              onDragOver={(event) => {
                if (canDrop) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged) moveTask(dragged, status);
                setDragged(null);
              }}
            >
              <header>
                <span
                  className={
                    "status-dot status-" + column.status.toLowerCase()
                  }
                />
                <h2>{STATUS_LABELS[status]}</h2>
                <span>{column.count}</span>
              </header>
              <div className="task-stack">
                {column.tasks.length === 0 ? (
                  <div className="column-empty">拖动任务到这里</div>
                ) : null}
                {column.tasks.map((task) => (
                  <article
                    className={
                      "task-card " +
                      (reorder.isLoading &&
                      reorder.variables?.number === task.number
                        ? "is-moving"
                        : "")
                    }
                    draggable
                    key={task.id}
                    onDragEnd={() => setDragged(null)}
                    onDragStart={() =>
                      setDragged({
                        number: task.number,
                        status: task.status as TaskStatus,
                        version: task.version,
                      })
                    }
                  >
                    <div className="task-card-top">
                      <span className="task-number">
                        {projectKey}-{task.number}
                      </span>
                      <GripVertical
                        className="drag-handle"
                        size={16}
                        aria-label="拖动任务"
                      />
                    </div>
                    <h3>{task.title}</h3>
                    {task.labels.length > 0 ? (
                      <div className="task-labels">
                        {task.labels.map(({ label }) => (
                          <span key={label.id}>
                            <i style={{ backgroundColor: label.color }} />
                            {label.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="task-card-meta">
                      <span
                        className={
                          "priority priority-" + task.priority.toLowerCase()
                        }
                      >
                        {PRIORITY_LABELS[task.priority]}
                      </span>
                      {task.dueDate ? (
                        <span>
                          <CalendarDays size={13} />
                          {formatDate(task.dueDate)}
                        </span>
                      ) : null}
                      <span className="task-assignee">
                        {task.assignee ? (
                          <Avatar
                            email={task.assignee.email}
                            name={task.assignee.name}
                            size="small"
                          />
                        ) : (
                          <UserRound size={15} />
                        )}
                      </span>
                    </div>
                    <label className="task-status-control">
                      <span className="sr-only">修改任务状态</span>
                      <select
                        aria-label={"修改 " + task.title + " 的状态"}
                        disabled={reorder.isLoading}
                        onChange={(event) =>
                          moveTask(
                            {
                              number: task.number,
                              status: task.status as TaskStatus,
                              version: task.version,
                            },
                            event.target.value as TaskStatus,
                          )
                        }
                        value={task.status}
                      >
                        {allowedTransitions[task.status as TaskStatus].map(
                          (nextStatus) => (
                            <option key={nextStatus} value={nextStatus}>
                              {STATUS_LABELS[nextStatus]}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {(board.data?.columns.reduce((sum, column) => sum + column.count, 0) ??
        0) === 0 && !createOpen ? (
        <EmptyState
          detail="创建第一条任务，开始组织这个项目的工作。"
          title="项目还没有任务"
        />
      ) : null}
    </div>
  );
}
