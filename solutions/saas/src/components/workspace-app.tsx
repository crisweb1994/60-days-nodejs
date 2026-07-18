"use client";

import {
  BarChart3,
  Bell,
  ChevronDown,
  Columns3,
  List,
  LogOut,
  Menu,
  Plus,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { BoardView } from "@/components/board-view";
import { DashboardView } from "@/components/dashboard-view";
import { ListView } from "@/components/list-view";
import { NotificationDrawer } from "@/components/notification-drawer";
import { Avatar, ErrorBanner, ViewSkeleton } from "@/components/ui";
import { useWorkspaceRealtime } from "@/hooks/use-workspace-realtime";
import { trpc } from "@/trpc/react";

type ViewName = "dashboard" | "board" | "list";

type User = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

const navigation = [
  { id: "dashboard" as const, label: "仪表盘", icon: BarChart3 },
  { id: "board" as const, label: "看板", icon: Columns3 },
  { id: "list" as const, label: "列表", icon: List },
];

export function WorkspaceApp({ user }: { user: User }) {
  const [view, setView] = useState<ViewName>("dashboard");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const workspaces = trpc.workspaces.list.useQuery();
  const projects = trpc.projects.list.useQuery(
    { workspaceSlug },
    { enabled: Boolean(workspaceSlug) },
  );
  const unread = trpc.notifications.unreadCount.useQuery(
    { workspaceSlug },
    { enabled: Boolean(workspaceSlug), refetchInterval: 30_000 },
  );
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => window.location.reload(),
  });
  useWorkspaceRealtime(workspaceSlug);

  useEffect(() => {
    const available = workspaces.data?.memberships ?? [];
    if (available.length === 0) return;
    if (!available.some((item) => item.workspace.slug === workspaceSlug)) {
      setWorkspaceSlug(available[0].workspace.slug);
    }
  }, [workspaceSlug, workspaces.data]);

  useEffect(() => {
    const available = projects.data?.projects ?? [];
    if (available.length === 0) {
      setProjectKey("");
      return;
    }
    if (!available.some((project) => project.key === projectKey)) {
      setProjectKey(available[0].key);
    }
  }, [projectKey, projects.data]);

  const currentWorkspace = useMemo(
    () =>
      workspaces.data?.memberships.find(
        (item) => item.workspace.slug === workspaceSlug,
      ),
    [workspaceSlug, workspaces.data],
  );
  const currentProject = projects.data?.projects.find(
    (project) => project.key === projectKey,
  );
  const title =
    view === "dashboard"
      ? "团队概览"
      : view === "board"
        ? "任务看板"
        : "任务列表";

  if (workspaces.isLoading) {
    return (
      <main className="boot-screen" aria-label="正在加载工作区">
        <ViewSkeleton rows={3} />
      </main>
    );
  }

  if (workspaces.error) {
    return (
      <main className="centered-state">
        <ErrorBanner message={workspaces.error.message} />
      </main>
    );
  }

  if ((workspaces.data?.memberships.length ?? 0) === 0) {
    return <WorkspaceSetup user={user} />;
  }

  return (
    <div className="app-shell">
      {sidebarOpen ? (
        <button
          aria-label="关闭导航"
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      ) : null}
      <aside className={"sidebar " + (sidebarOpen ? "is-open" : "")}>
        <div className="sidebar-brand">
          <span className="brand-mark brand-mark-inverse">R</span>
          <span>Relay</span>
          <button
            aria-label="关闭导航"
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="sidebar-section">
          <div className="section-label-row">
            <span>工作区</span>
            <button
              aria-label="新建工作区"
              className="bare-icon-button"
              onClick={() => setShowWorkspaceForm((value) => !value)}
              title="新建工作区"
              type="button"
            >
              <Plus size={15} />
            </button>
          </div>
          <label className="workspace-select">
            <span className="workspace-glyph">
              {currentWorkspace?.workspace.name.slice(0, 1).toUpperCase()}
            </span>
            <select
              aria-label="选择工作区"
              onChange={(event) => {
                setWorkspaceSlug(event.target.value);
                setSidebarOpen(false);
              }}
              value={workspaceSlug}
            >
              {workspaces.data?.memberships.map(({ workspace }) => (
                <option key={workspace.id} value={workspace.slug}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          {showWorkspaceForm ? (
            <CompactWorkspaceForm
              onDone={() => setShowWorkspaceForm(false)}
            />
          ) : null}
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={view === item.id ? "page" : undefined}
                className={view === item.id ? "is-active" : ""}
                key={item.id}
                onClick={() => {
                  setView(item.id);
                  setSidebarOpen(false);
                }}
                type="button"
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-user">
          <Avatar email={user.email} name={user.name} />
          <span>
            <strong>{user.name ?? "未命名用户"}</strong>
            <small>{user.email}</small>
          </span>
          <button
            aria-label="退出登录"
            className="icon-button icon-button-dark"
            disabled={logout.isLoading}
            onClick={() => logout.mutate()}
            title="退出登录"
            type="button"
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <button
            aria-label="打开导航"
            className="icon-button mobile-menu"
            onClick={() => setSidebarOpen(true)}
            type="button"
          >
            <Menu size={19} />
          </button>
          <div className="page-heading">
            <span>{currentWorkspace?.workspace.name}</span>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <div className="project-control">
              <select
                aria-label="选择项目"
                disabled={(projects.data?.projects.length ?? 0) === 0}
                onChange={(event) => setProjectKey(event.target.value)}
                value={projectKey}
              >
                {(projects.data?.projects ?? []).map((project) => (
                  <option key={project.id} value={project.key}>
                    {project.key} · {project.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </div>
            <button
              aria-label="新建项目"
              className="icon-button"
              onClick={() => setShowProjectForm((value) => !value)}
              title="新建项目"
              type="button"
            >
              <Plus size={18} />
            </button>
            <button
              aria-label="通知"
              className="icon-button notification-button"
              onClick={() => setNotificationsOpen(true)}
              title="通知"
              type="button"
            >
              <Bell size={18} />
              {(unread.data?.count ?? 0) > 0 ? (
                <span>{Math.min(unread.data?.count ?? 0, 99)}</span>
              ) : null}
            </button>
          </div>
        </header>

        {showProjectForm && workspaceSlug ? (
          <InlineProjectForm
            onDone={() => setShowProjectForm(false)}
            workspaceSlug={workspaceSlug}
          />
        ) : null}

        <div className="view-container">
          {(projects.data?.projects.length ?? 0) === 0 ? (
            <ProjectSetup workspaceSlug={workspaceSlug} />
          ) : view === "dashboard" ? (
            <DashboardView
              projectKey={currentProject?.key}
              workspaceSlug={workspaceSlug}
            />
          ) : view === "board" && currentProject ? (
            <BoardView
              projectKey={currentProject.key}
              workspaceSlug={workspaceSlug}
            />
          ) : view === "list" ? (
            <ListView
              projectKey={currentProject?.key}
              workspaceSlug={workspaceSlug}
            />
          ) : null}
        </div>
      </main>

      <NotificationDrawer
        onClose={() => setNotificationsOpen(false)}
        open={notificationsOpen}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}

function WorkspaceSetup({ user }: { user: User }) {
  return (
    <main className="setup-screen">
      <div className="setup-header">
        <span className="brand-mark">R</span>
        <span>Relay</span>
      </div>
      <section className="setup-content">
        <span className="setup-step">第一步</span>
        <h1>建立你的工作区</h1>
        <p>{user.name ?? user.email}，用团队或业务单元的名称开始。</p>
        <WorkspaceForm />
      </section>
    </main>
  );
}

function WorkspaceForm({ onDone }: { onDone?: () => void }) {
  const utils = trpc.useUtils();
  const create = trpc.workspaces.create.useMutation({
    onSuccess: async () => {
      await utils.workspaces.list.invalidate();
      onDone?.();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      name: String(data.get("name") ?? ""),
      slug: String(data.get("slug") ?? ""),
    });
  }

  return (
    <form className="setup-form" onSubmit={submit}>
      <label className="field">
        <span>工作区名称</span>
        <input name="name" placeholder="例如：产品研发部" required />
      </label>
      <label className="field">
        <span>网址标识</span>
        <input
          minLength={3}
          name="slug"
          pattern="[a-z0-9][a-z0-9-]+[a-z0-9]"
          placeholder="product-team"
          required
        />
      </label>
      {create.error ? <ErrorBanner message={create.error.message} /> : null}
      <button
        className="primary-button"
        disabled={create.isLoading}
        type="submit"
      >
        {create.isLoading ? "创建中…" : "创建工作区"}
      </button>
    </form>
  );
}

function CompactWorkspaceForm({ onDone }: { onDone: () => void }) {
  return (
    <div className="sidebar-inline-form">
      <WorkspaceForm onDone={onDone} />
    </div>
  );
}

function ProjectSetup({ workspaceSlug }: { workspaceSlug: string }) {
  return (
    <section className="content-setup">
      <span className="setup-step">下一步</span>
      <h2>创建第一个项目</h2>
      <p>项目把相关任务、进度和团队讨论放在一起。</p>
      <ProjectForm workspaceSlug={workspaceSlug} />
    </section>
  );
}

function InlineProjectForm({
  workspaceSlug,
  onDone,
}: {
  workspaceSlug: string;
  onDone: () => void;
}) {
  return (
    <div className="inline-create">
      <strong>新建项目</strong>
      <ProjectForm onDone={onDone} workspaceSlug={workspaceSlug} />
    </div>
  );
}

function ProjectForm({
  workspaceSlug,
  onDone,
}: {
  workspaceSlug: string;
  onDone?: () => void;
}) {
  const utils = trpc.useUtils();
  const create = trpc.projects.create.useMutation({
    onSuccess: async () => {
      await utils.projects.list.invalidate({ workspaceSlug });
      onDone?.();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    create.mutate(
      {
        workspaceSlug,
        key: String(data.get("key") ?? ""),
        name: String(data.get("name") ?? ""),
      },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <form className="project-form" onSubmit={submit}>
      <label className="field compact-field">
        <span>项目 Key</span>
        <input
          maxLength={6}
          minLength={2}
          name="key"
          placeholder="ENG"
          required
        />
      </label>
      <label className="field compact-field project-name-field">
        <span>项目名称</span>
        <input name="name" placeholder="Engineering" required />
      </label>
      <button
        className="primary-button"
        disabled={create.isLoading}
        type="submit"
      >
        {create.isLoading ? "创建中…" : "创建项目"}
      </button>
      {create.error ? <ErrorBanner message={create.error.message} /> : null}
    </form>
  );
}
