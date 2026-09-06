import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  callerFor,
  createTask,
  prisma,
  resetDatabase,
  seedWorld,
  trpcCode,
} from "./test-utils";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("tasks.addComment / upsertLabel", () => {
  it("评论后任务详情按时间正序返回评论", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const task = await createTask(caller, workspaceSlug, projectKey, "Commented");

    await caller.tasks.addComment({
      workspaceSlug,
      projectKey,
      number: task.number,
      body: "First comment",
    });
    await caller.tasks.addComment({
      workspaceSlug,
      projectKey,
      number: task.number,
      body: "Second comment",
    });

    const detail = await caller.tasks.get({
      workspaceSlug,
      projectKey,
      number: task.number,
    });
    expect(detail.task.comments.map((comment) => comment.body)).toEqual([
      "First comment",
      "Second comment",
    ]);
    expect(detail.task.comments[0].author.email).toBeTruthy();
  });

  it("标签按工作区去重，重复创建返回同一条", async () => {
    const { caller, workspaceSlug } = await seedWorld();

    const first = await caller.tasks.upsertLabel({
      workspaceSlug,
      name: "bug",
      color: "#ff0000",
    });
    const second = await caller.tasks.upsertLabel({
      workspaceSlug,
      name: "bug",
      color: "#00ff00",
    });

    expect(second.label.id).toBe(first.label.id);
    expect(second.label.color).toBe("#00ff00");

    const labels = await prisma.label.count();
    expect(labels).toBe(1);
  });

  it("非法颜色格式被输入层拒绝", async () => {
    const { caller, workspaceSlug } = await seedWorld();

    const error = await caller.tasks
      .upsertLabel({ workspaceSlug, name: "bad", color: "red" })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("BAD_REQUEST");
  });
});

describe("projects.update / workspaces.members", () => {
  it("项目改名与归档状态可以被更新", async () => {
    const { caller, workspaceSlug } = await seedWorld();

    const updated = await caller.projects.update({
      workspaceSlug,
      key: "ENG",
      name: "Platform Engineering",
      description: "Renamed",
    });
    expect(updated.project.name).toBe("Platform Engineering");

    const archived = await caller.projects.update({
      workspaceSlug,
      key: "ENG",
      archived: true,
    });
    expect(archived.project.archivedAt).not.toBeNull();
  });

  it("成员列表包含创建者且角色为 OWNER", async () => {
    const { caller, workspaceSlug } = await seedWorld();

    const { members } = await caller.workspaces.members({ slug: workspaceSlug });
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("OWNER");
  });
});
