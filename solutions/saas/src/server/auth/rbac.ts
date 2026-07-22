import type { Role } from "@prisma/client";

const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasRoleAtLeast(role: Role, minimumRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimumRole];
}
