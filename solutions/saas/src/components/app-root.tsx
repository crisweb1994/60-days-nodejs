"use client";

import { LoaderCircle } from "lucide-react";

import { AuthScreen } from "@/components/auth-screen";
import { WorkspaceApp } from "@/components/workspace-app";
import { trpc } from "@/trpc/react";

export function AppRoot() {
  const me = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });

  if (me.isLoading) {
    return (
      <main className="boot-screen" aria-label="正在加载">
        <div className="brand-mark" aria-hidden="true">
          R
        </div>
        <LoaderCircle className="spin" size={22} />
      </main>
    );
  }

  if (!me.data?.user) {
    return <AuthScreen />;
  }

  return <WorkspaceApp user={me.data.user} />;
}
