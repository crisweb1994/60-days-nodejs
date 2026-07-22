import { PrismaClient, Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { hasRoleAtLeast } from "@/server/auth/rbac";

export const workspaceSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, {
    message:
      "Slug must be 3-40 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen",
  });

export const workspaceNameSchema = z.string().trim().min(1).max(100);

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  workspaceSlug: string,
  minimumRole: Role = Role.VIEWER,
) {
  const workspace = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
    select: {
      id: true,
      slug: true,
      name: true,
      avatarUrl: true,
      memberships: {
        where: { userId },
        select: { id: true, role: true },
      },
    },
  });

  const membership = workspace?.memberships[0];
  if (!workspace || !membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this workspace",
    });
  }

  if (!hasRoleAtLeast(membership.role, minimumRole)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Insufficient workspace role",
    });
  }

  return {
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      avatarUrl: workspace.avatarUrl,
    },
    membership,
  };
}
