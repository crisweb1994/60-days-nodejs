import type { RealtimeEvent, RealtimeUser } from "@/server/realtime/events";

type Subscriber = {
  id: string;
  user: RealtimeUser;
  send: (event: RealtimeEvent) => void;
};

class RealtimeEventBus {
  private readonly subscribersByWorkspace = new Map<string, Map<string, Subscriber>>();

  subscribe(workspaceId: string, subscriber: Subscriber): () => void {
    const subscribers = this.getWorkspaceSubscribers(workspaceId);
    const wasUserOnline = this.isUserOnline(workspaceId, subscriber.user.id);

    subscribers.set(subscriber.id, subscriber);
    subscriber.send({
      type: "presence.snapshot",
      workspaceId,
      users: this.getOnlineUsers(workspaceId),
      at: new Date().toISOString(),
    });

    if (!wasUserOnline) {
      this.publish(workspaceId, {
        type: "presence.joined",
        workspaceId,
        user: subscriber.user,
        at: new Date().toISOString(),
      });
    }

    return () => {
      const currentSubscribers = this.subscribersByWorkspace.get(workspaceId);
      if (!currentSubscribers) {
        return;
      }

      currentSubscribers.delete(subscriber.id);
      if (!this.isUserOnline(workspaceId, subscriber.user.id)) {
        this.publish(workspaceId, {
          type: "presence.left",
          workspaceId,
          user: subscriber.user,
          at: new Date().toISOString(),
        });
      }

      if (currentSubscribers.size === 0) {
        this.subscribersByWorkspace.delete(workspaceId);
      }
    };
  }

  publish(workspaceId: string, event: RealtimeEvent): void {
    const subscribers = this.subscribersByWorkspace.get(workspaceId);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers.values()) {
      subscriber.send(event);
    }
  }

  getOnlineUsers(workspaceId: string): RealtimeUser[] {
    const subscribers = this.subscribersByWorkspace.get(workspaceId);
    if (!subscribers) {
      return [];
    }

    const usersById = new Map<string, RealtimeUser>();
    for (const subscriber of subscribers.values()) {
      usersById.set(subscriber.user.id, subscriber.user);
    }

    return [...usersById.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  private getWorkspaceSubscribers(workspaceId: string): Map<string, Subscriber> {
    const existing = this.subscribersByWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }

    const subscribers = new Map<string, Subscriber>();
    this.subscribersByWorkspace.set(workspaceId, subscribers);
    return subscribers;
  }

  private isUserOnline(workspaceId: string, userId: string): boolean {
    return this.getOnlineUsers(workspaceId).some((user) => user.id === userId);
  }
}

const globalForRealtime = globalThis as unknown as {
  realtimeEventBus?: RealtimeEventBus;
};

export const realtimeEventBus =
  globalForRealtime.realtimeEventBus ?? new RealtimeEventBus();

globalForRealtime.realtimeEventBus = realtimeEventBus;
