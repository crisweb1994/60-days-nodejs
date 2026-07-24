-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TASK_ASSIGNED', 'TASK_COMMENTED', 'TASK_STATUS_CHANGED');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('SKIPPED', 'PENDING', 'QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(100),
    "password_hash" VARCHAR(255),
    "avatar_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(40) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "avatar_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "token" VARCHAR(64) NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" VARCHAR(6) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(20),
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_task_counters" (
    "project_id" UUID NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "project_task_counters_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'BACKLOG',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NONE',
    "assignee_id" UUID,
    "reporter_id" UUID,
    "due_date" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "color" VARCHAR(7) NOT NULL DEFAULT '#6b7280',

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_labels" (
    "task_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,

    CONSTRAINT "task_labels_pkey" PRIMARY KEY ("task_id","label_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "visible_in_app" BOOLEAN NOT NULL DEFAULT true,
    "read_at" TIMESTAMPTZ(3),
    "email_status" "EmailDeliveryStatus" NOT NULL DEFAULT 'SKIPPED',
    "email_queued_at" TIMESTAMPTZ(3),
    "email_sent_at" TIMESTAMPTZ(3),
    "email_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "task_assigned" BOOLEAN NOT NULL DEFAULT true,
    "task_commented" BOOLEAN NOT NULL DEFAULT true,
    "task_status_changed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","workspace_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "memberships_workspace_id_idx" ON "memberships"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_workspace_id_key" ON "memberships"("user_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE INDEX "invitations_workspace_id_email_idx" ON "invitations"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "projects_workspace_id_idx" ON "projects"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_key_key" ON "projects"("workspace_id", "key");

-- CreateIndex
CREATE INDEX "tasks_project_id_status_order_idx" ON "tasks"("project_id", "status", "order");

-- CreateIndex
CREATE INDEX "tasks_assignee_id_status_idx" ON "tasks"("assignee_id", "status");

-- CreateIndex
CREATE INDEX "tasks_project_id_completed_at_idx" ON "tasks"("project_id", "completed_at");

-- CreateIndex
CREATE INDEX "tasks_project_id_due_date_idx" ON "tasks"("project_id", "due_date");

-- CreateIndex
CREATE INDEX "tasks_created_at_idx" ON "tasks"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_project_id_number_key" ON "tasks"("project_id", "number");

-- CreateIndex
CREATE INDEX "comments_task_id_created_at_idx" ON "comments"("task_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "labels_workspace_id_name_key" ON "labels"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_visible_in_app_read_at_created_a_idx" ON "notifications"("recipient_id", "visible_in_app", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_workspace_id_created_at_idx" ON "notifications"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_email_status_created_at_idx" ON "notifications"("email_status", "created_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_task_counters" ADD CONSTRAINT "project_task_counters_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

