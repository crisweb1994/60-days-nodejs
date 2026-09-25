import { TaskStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  allowedTaskStatusTransitions,
  canTransitionTaskStatus,
} from "@/server/domain/task-status";

// 状态机是这个项目少数“纯逻辑但错了会直接污染数据”的模块：
// DONE 的任务被拉回 BACKLOG、CANCELLED 直接复活，都属于看板语义事故。
// 因此这里不做抽样，而是把整张转移表跑满。
const ALL_STATUSES = Object.values(TaskStatus);

describe("canTransitionTaskStatus", () => {
  it("同状态幂等切换永远合法", () => {
    for (const status of ALL_STATUSES) {
      expect(canTransitionTaskStatus(status, status)).toBe(true);
    }
  });

  it("按声明的转移表逐格验证合法路径", () => {
    const legal: Array<[TaskStatus, TaskStatus]> = [
      [TaskStatus.BACKLOG, TaskStatus.TODO],
      [TaskStatus.BACKLOG, TaskStatus.CANCELLED],
      [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
      [TaskStatus.TODO, TaskStatus.CANCELLED],
      [TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW],
      [TaskStatus.IN_PROGRESS, TaskStatus.TODO],
      [TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
      [TaskStatus.IN_REVIEW, TaskStatus.DONE],
      [TaskStatus.IN_REVIEW, TaskStatus.IN_PROGRESS],
      [TaskStatus.IN_REVIEW, TaskStatus.CANCELLED],
      [TaskStatus.DONE, TaskStatus.IN_REVIEW],
      [TaskStatus.CANCELLED, TaskStatus.BACKLOG],
    ];

    for (const [from, to] of legal) {
      expect(canTransitionTaskStatus(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("未声明的组合一律拒绝", () => {
    const legalPairs = new Set(
      ALL_STATUSES.flatMap((from) =>
        allowedTaskStatusTransitions(from).map((to) => `${from}->${to}`),
      ),
    );

    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const key = `${from}->${to}`;
        if (legalPairs.has(key) || from === to) {
          continue;
        }
        expect(canTransitionTaskStatus(from, to), key).toBe(false);
      }
    }
  });

  it("关键业务约束：DONE 不能直接回到 TODO 或 BACKLOG", () => {
    expect(canTransitionTaskStatus(TaskStatus.DONE, TaskStatus.TODO)).toBe(
      false,
    );
    expect(canTransitionTaskStatus(TaskStatus.DONE, TaskStatus.BACKLOG)).toBe(
      false,
    );
  });
});

describe("allowedTaskStatusTransitions", () => {
  it("每个状态至少有一个出口，不会出现死锁状态", () => {
    for (const status of ALL_STATUSES) {
      expect(allowedTaskStatusTransitions(status).length).toBeGreaterThan(0);
    }
  });
});
