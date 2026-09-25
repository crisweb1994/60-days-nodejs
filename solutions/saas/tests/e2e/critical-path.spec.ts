import { expect, test } from "@playwright/test";

// 关键路径 E2E：一个新用户从注册到在看板上看到自己的第一张任务。
// 选择器全部使用可访问名称（label、button 文案），不依赖 class 或 DOM 结构，
// 样式重构不应该弄坏这组测试。
test("注册 -> 建工作区 -> 建项目 -> 看板创建任务", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const email = `e2e-${runId}@test.local`;
  const password = "password-123456";
  const workspaceSlug = `e2e-ws-${runId}`.slice(0, 40);

  await page.goto("/");

  // 注册
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByLabel("姓名").fill("E2E Runner");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();

  // 引导页：创建工作区
  await expect(
    page.getByRole("heading", { name: "建立你的工作区" }),
  ).toBeVisible();
  await page.getByLabel("工作区名称").fill("E2E 测试工作区");
  await page.getByLabel("网址标识").fill(workspaceSlug);
  await page.getByRole("button", { name: "创建工作区" }).click();

  // 引导页：创建项目
  await expect(
    page.getByRole("heading", { name: "创建第一个项目" }),
  ).toBeVisible();
  await page.getByLabel("项目 Key").fill("ENG");
  await page.getByLabel("项目名称", { exact: true }).fill("Engineering");
  await page.getByRole("button", { name: "创建项目" }).click();

  // 进入看板并创建任务
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByRole("button", { name: "新建任务" }).click();
  await page.getByLabel("任务标题").fill("第一张 E2E 任务");
  await page.getByRole("button", { name: "添加任务" }).click();

  // 快速新建的任务落在“待开始”（TODO）列。断言列小节而不是整页，
  // 避免误匹配其他文案；web-first 断言会自动等待接口返回和渲染完成。
  const todoColumn = page
    .getByRole("heading", { name: "待开始" })
    .locator("..")
    .locator("..");
  await expect(todoColumn).toContainText("第一张 E2E 任务");

  // 刷新后仍然在——排除“只写进了内存”的假象
  await page.reload();
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await expect(page.getByText("第一张 E2E 任务")).toBeVisible();
});

test("密码错误时登录被拒绝，且错误信息可见", async ({ page }) => {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const email = `e2e-${runId}@test.local`;
  const password = "password-123456";
  const workspaceSlug = `e2e-ws-${runId}`.slice(0, 40);

  // 注册并创建工作区，让侧边栏（退出登录按钮）出现。
  await page.goto("/");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByLabel("姓名").fill("E2E Runner");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(
    page.getByRole("heading", { name: "建立你的工作区" }),
  ).toBeVisible();
  await page.getByLabel("工作区名称").fill("E2E 登录测试");
  await page.getByLabel("网址标识").fill(workspaceSlug);
  await page.getByRole("button", { name: "创建工作区" }).click();

  // 退出登录（清 cookie），再用错误密码登录。
  // 页面上有两个“登录”按钮（模式切换和表单提交），提交用回车代替点击。
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "继续工作" })).toBeVisible();

  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill("wrong-password");
  await page.getByLabel("密码").press("Enter");

  // 不用 getByRole("alert")：Next.js 的 route announcer 也是 alert 角色，
  // 会触发严格模式冲突。直接按文案断言。
  await expect(page.getByText("Invalid email or password")).toBeVisible();
});
