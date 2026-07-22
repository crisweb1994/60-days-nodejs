import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { appRouter } from "@/server/routers/_app";
import { createTRPCContext } from "@/server/trpc";

function handler(request: NextRequest) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: (opts) => createTRPCContext(opts),
  });
}

export { handler as GET, handler as POST };
