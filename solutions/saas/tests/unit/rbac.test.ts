import { Role } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { hasRoleAtLeast } from "@/server/auth/rbac";

describe("hasRoleAtLeast", () => {
  it("每个角色都满足自己的最低要求", () => {
    for (const role of Object.values(Role)) {
      expect(hasRoleAtLeast(role, role), role).toBe(true);
    }
  });

  it("等级序关系 OWNER > ADMIN > MEMBER > VIEWER 全组合验证", () => {
    const expectations: Array<[Role, Role, boolean]> = [
      // 高角色满足低要求
      [Role.OWNER, Role.ADMIN, true],
      [Role.OWNER, Role.MEMBER, true],
      [Role.OWNER, Role.VIEWER, true],
      [Role.ADMIN, Role.MEMBER, true],
      [Role.ADMIN, Role.VIEWER, true],
      [Role.MEMBER, Role.VIEWER, true],
      // 低角色不满足高要求
      [Role.VIEWER, Role.MEMBER, false],
      [Role.VIEWER, Role.ADMIN, false],
      [Role.VIEWER, Role.OWNER, false],
      [Role.MEMBER, Role.ADMIN, false],
      [Role.MEMBER, Role.OWNER, false],
      [Role.ADMIN, Role.OWNER, false],
    ];

    for (const [role, minimum, expected] of expectations) {
      expect(hasRoleAtLeast(role, minimum), `${role} >= ${minimum}`).toBe(
        expected,
      );
    }
  });
});
