import { describe, expect, it } from "vitest";

import { realtimeEventBus } from "@/server/realtime/event-bus";

type Subscriber = {
  id: string;
  user: { id: string; email: string; name: string | null; avatarUrl: string | null };
};

// 事件总线是纯内存 pub/sub：行为全部可以同步验证。
// 每个用例用随机 workspaceId，避免单例在用例之间串状态。
function makeSubscriber(id: string, userId: string) {
  const received: unknown[] = [];
  return {
    received,
    handle: {
      id,
      user: { id: userId, email: `${userId}@test.local`, name: null, avatarUrl: null },
      send: (event: unknown) => received.push(event),
    },
  };
}

function randomWorkspaceId(): string {
  return crypto.randomUUID();
}

describe("realtimeEventBus", () => {
  it("publish 只投递给同一工作区的订阅者", () => {
    const workspaceA = randomWorkspaceId();
    const workspaceB = randomWorkspaceId();
    const a = makeSubscriber("a-1", "user-a");
    const b = makeSubscriber("b-1", "user-b");

    const offA = realtimeEventBus.subscribe(workspaceA, a.handle);
    realtimeEventBus.subscribe(workspaceB, b.handle);

    realtimeEventBus.publish(workspaceA, {
      type: "task.created",
      workspaceId: workspaceA,
      actor: a.handle.user,
      task: {
        id: "t1",
        number: 1,
        title: "hello",
        status: "BACKLOG",
        priority: "NONE",
        order: 1000,
        version: 1,
        projectKey: "ENG",
      },
      at: new Date().toISOString(),
    });

    const aTypes = a.received.map((event) => (event as { type: string }).type);
    const bTypes = b.received.map((event) => (event as { type: string }).type);

    expect(aTypes).toContain("task.created");
    expect(bTypes).not.toContain("task.created");
    offA();
  });

  it("订阅时收到在线用户快照；presence.joined 广播给包括新人在内的所有人", () => {
    const workspaceId = randomWorkspaceId();
    const first = makeSubscriber("s-1", "user-1");
    const second = makeSubscriber("s-2", "user-2");

    const off1 = realtimeEventBus.subscribe(workspaceId, first.handle);
    const firstTypes = first.received.map((e) => (e as { type: string }).type);
    expect(firstTypes).toEqual(["presence.snapshot", "presence.joined"]);

    // 新用户加入：广播发给所有订阅者（含新人自己），
    // 对 presence UI 无害——收到自己的 joined 只是幂等地更新一次在线列表。
    const off2 = realtimeEventBus.subscribe(workspaceId, second.handle);
    const secondTypes = second.received.map((e) => (e as { type: string }).type);
    expect(secondTypes).toEqual(["presence.snapshot", "presence.joined"]);

    off1();
    off2();
  });

  it("同一用户第二个连接退出不广播 presence.left，最后一个退出才广播", () => {
    const workspaceId = randomWorkspaceId();
    const tab1 = makeSubscriber("tab-1", "user-x");
    const tab2 = makeSubscriber("tab-2", "user-x");
    const observer = makeSubscriber("obs", "user-o");

    const offObs = realtimeEventBus.subscribe(workspaceId, observer.handle);
    const off1 = realtimeEventBus.subscribe(workspaceId, tab1.handle);
    const off2 = realtimeEventBus.subscribe(workspaceId, tab2.handle);
    observer.received.length = 0;

    off1();
    let leftCount = observer.received.filter(
      (e) => (e as { type: string }).type === "presence.left",
    ).length;
    expect(leftCount).toBe(0);

    off2();
    leftCount = observer.received.filter(
      (e) => (e as { type: string }).type === "presence.left",
    ).length;
    expect(leftCount).toBe(1);

    offObs();
  });

  it("没有订阅者时 publish 静默返回", () => {
    expect(() =>
      realtimeEventBus.publish(randomWorkspaceId(), {
        type: "presence.joined",
        workspaceId: "none",
        user: { id: "u", email: "u@t.local", name: null, avatarUrl: null },
        at: new Date().toISOString(),
      }),
    ).not.toThrow();
  });
});
