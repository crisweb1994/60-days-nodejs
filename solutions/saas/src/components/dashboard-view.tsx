"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  RefreshCw,
  Users,
} from "lucide-react";
import { CSSProperties, useMemo, useState } from "react";

import {
  Avatar,
  ErrorBanner,
  STATUS_LABELS,
  ViewSkeleton,
} from "@/components/ui";
import { trpc } from "@/trpc/react";

export function DashboardView({
  workspaceSlug,
  projectKey,
}: {
  workspaceSlug: string;
  projectKey?: string;
}) {
  const [scope, setScope] = useState<"workspace" | "project">("workspace");
  const selectedProject =
    scope === "project" && projectKey ? projectKey : undefined;
  const periodInput = {
    workspaceSlug,
    projectKey: selectedProject,
    days: 30,
  };
  const scopeInput = { workspaceSlug, projectKey: selectedProject };
  const overview = trpc.analytics.overview.useQuery(periodInput);
  const trend = trpc.analytics.completionTrend.useQuery(periodInput);
  const workload = trpc.analytics.workload.useQuery(scopeInput);
  const progress = trpc.analytics.projectProgress.useQuery(scopeInput);
  const errors = [
    overview.error,
    trend.error,
    workload.error,
    progress.error,
  ].filter(Boolean);

  function refresh() {
    void Promise.all([
      overview.refetch(),
      trend.refetch(),
      workload.refetch(),
      progress.refetch(),
    ]);
  }

  if (
    overview.isLoading ||
    trend.isLoading ||
    workload.isLoading ||
    progress.isLoading
  ) {
    return <ViewSkeleton rows={6} />;
  }

  if (errors[0]) {
    return <ErrorBanner message={errors[0]?.message ?? "统计数据加载失败"} />;
  }

  const summary = overview.data;
  if (!summary || !trend.data || !workload.data || !progress.data) {
    return null;
  }

  return (
    <div className="dashboard-view">
      <div className="view-toolbar">
        <div className="segmented compact-segmented" aria-label="统计范围">
          <button
            className={scope === "workspace" ? "is-active" : ""}
            onClick={() => setScope("workspace")}
            type="button"
          >
            全部项目
          </button>
          <button
            className={scope === "project" ? "is-active" : ""}
            disabled={!projectKey}
            onClick={() => setScope("project")}
            type="button"
          >
            当前项目
          </button>
        </div>
        <button
          aria-label="刷新统计"
          className="secondary-button icon-text-button"
          onClick={refresh}
          type="button"
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </div>

      <section className="metric-strip" aria-label="任务总览">
        <Metric
          icon={<CircleDashed size={18} />}
          label="任务总数"
          value={summary.total}
        />
        <Metric
          icon={<CheckCircle2 size={18} />}
          label="完成率"
          suffix="%"
          value={summary.completionRate}
        />
        <Metric
          icon={<AlertTriangle size={18} />}
          label="已逾期"
          tone="danger"
          value={summary.overdue}
        />
        <Metric
          icon={<Users size={18} />}
          label="未分配"
          value={summary.unassigned}
        />
      </section>

      <section className="pulse-section">
        <div className="section-heading">
          <div>
            <h2>工作脉冲</h2>
            <p>过去 30 天每天完成的任务数量，按 UTC 自然日统计。</p>
          </div>
          <span className="period-total">
            {summary.completedInPeriod}
            <small>本周期完成</small>
          </span>
        </div>
        <CompletionChart days={trend.data.days} />
      </section>

      <div className="dashboard-split">
        <section className="data-section">
          <div className="section-heading">
            <div>
              <h2>团队工作量</h2>
              <p>当前任务分布及个人完成情况。</p>
            </div>
          </div>
          <div className="workload-list">
            {workload.data.members.map((member) => (
              <div className="workload-row" key={member.userId ?? "unassigned"}>
                <Avatar email={member.email} name={member.name} size="small" />
                <span className="workload-person">
                  <strong>{member.name ?? member.email ?? "历史成员"}</strong>
                  <small>
                    {member.userId === null
                      ? "等待分配"
                      : member.role ?? "历史成员"}
                  </small>
                </span>
                <span className="workload-track" aria-hidden="true">
                  <i style={{ width: member.sharePercent + "%" }} />
                </span>
                <span className="workload-number">
                  <strong>{member.total}</strong>
                  <small>{member.completionRate}% 完成</small>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="data-section">
          <div className="section-heading">
            <div>
              <h2>项目进度</h2>
              <p>完成、进行中和积压任务一览。</p>
            </div>
          </div>
          <div className="project-progress-list">
            {progress.data.projects.map((project) => (
              <div className="project-progress-row" key={project.id}>
                <span className="project-key">{project.key}</span>
                <span className="project-progress-name">
                  <strong>{project.name}</strong>
                  <small>
                    {project.done} 完成 · {project.active} 进行中 ·{" "}
                    {project.backlog} 积压
                  </small>
                </span>
                <span
                  aria-label={"完成率 " + project.completionRate + "%"}
                  className="radial-progress"
                  style={
                    {
                      "--progress": project.completionRate + "%",
                    } as CSSProperties
                  }
                >
                  {project.completionRate}%
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="status-band" aria-label="状态分布">
        {summary.statusDistribution.map((item) => (
          <span key={item.status}>
            <i className={"status-dot status-" + item.status.toLowerCase()} />
            {STATUS_LABELS[item.status]}
            <strong>{item.count}</strong>
          </span>
        ))}
      </section>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  suffix,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  suffix?: string;
  tone?: "danger";
}) {
  return (
    <div className={"metric-item " + (tone ? "metric-" + tone : "")}>
      <span className="metric-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <strong>
          {value}
          {suffix}
        </strong>
      </span>
    </div>
  );
}

function CompletionChart({
  days,
}: {
  days: Array<{ date: string; completed: number; cumulative: number }>;
}) {
  const max = Math.max(...days.map((day) => day.completed), 1);
  const labels = useMemo(
    () => new Set([0, Math.floor(days.length / 2), days.length - 1]),
    [days.length],
  );

  return (
    <div className="pulse-chart" role="img" aria-label="每日完成任务柱状图">
      <div className="pulse-bars">
        {days.map((day, index) => (
          <span
            className="pulse-column"
            key={day.date}
            title={day.date + "：" + day.completed + " 个任务"}
          >
            <i
              className={day.completed > 0 ? "has-value" : ""}
              style={{ height: Math.max((day.completed / max) * 100, 3) + "%" }}
            />
            {labels.has(index) ? (
              <small>{day.date.slice(5).replace("-", "/")}</small>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}
