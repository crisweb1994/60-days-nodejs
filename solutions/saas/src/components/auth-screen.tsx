"use client";

import { ArrowRight, Check, LogIn, UserPlus } from "lucide-react";
import { FormEvent, useState } from "react";

import { trpc } from "@/trpc/react";

type AuthMode = "login" | "register";

export function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("login");
  const utils = trpc.useUtils();
  const login = trpc.auth.login.useMutation({
    onSuccess: () => utils.auth.me.invalidate(),
  });
  const register = trpc.auth.register.useMutation({
    onSuccess: () => utils.auth.me.invalidate(),
  });
  const mutation = mode === "login" ? login : register;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    if (mode === "login") {
      login.mutate({ email, password });
      return;
    }
    register.mutate({
      email,
      password,
      name: String(form.get("name") ?? ""),
    });
  }

  return (
    <main className="auth-shell">
      <section className="auth-context" aria-label="Relay">
        <div className="auth-brand">
          <span className="brand-mark brand-mark-inverse">R</span>
          <span>Relay</span>
        </div>
        <div className="auth-message">
          <h1>把团队的下一步，放在同一个视野里。</h1>
          <p>任务、进度和提醒保持同步，讨论结束后，每个人都知道接下来做什么。</p>
        </div>
        <ul className="auth-points">
          <li>
            <Check size={16} aria-hidden="true" />
            项目看板与任务列表
          </li>
          <li>
            <Check size={16} aria-hidden="true" />
            团队负载与完成趋势
          </li>
          <li>
            <Check size={16} aria-hidden="true" />
            实时协作与通知
          </li>
        </ul>
      </section>

      <section className="auth-form-wrap">
        <div className="auth-form-header">
          <div className="auth-mobile-brand">
            <span className="brand-mark">R</span>
            <span>Relay</span>
          </div>
          <h2>{mode === "login" ? "继续工作" : "创建账号"}</h2>
          <p>
            {mode === "login"
              ? "登录你的团队工作区。"
              : "创建账号后即可建立第一个工作区。"}
          </p>
        </div>

        <div className="segmented" aria-label="认证方式">
          <button
            className={mode === "login" ? "is-active" : ""}
            onClick={() => setMode("login")}
            type="button"
          >
            登录
          </button>
          <button
            className={mode === "register" ? "is-active" : ""}
            onClick={() => setMode("register")}
            type="button"
          >
            注册
          </button>
        </div>

        <form className="form-stack" onSubmit={submit}>
          {mode === "register" ? (
            <label className="field">
              <span>姓名</span>
              <input
                autoComplete="name"
                maxLength={100}
                name="name"
                placeholder="你的姓名"
                required
              />
            </label>
          ) : null}
          <label className="field">
            <span>邮箱</span>
            <input
              autoComplete="email"
              name="email"
              placeholder="name@company.com"
              required
              type="email"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={8}
              name="password"
              placeholder="至少 8 个字符"
              required
              type="password"
            />
          </label>

          {mutation.error ? (
            <p className="form-error" role="alert">
              {mutation.error.message}
            </p>
          ) : null}

          <button
            className="primary-button auth-submit"
            disabled={mutation.isLoading}
            type="submit"
          >
            {mode === "login" ? <LogIn size={17} /> : <UserPlus size={17} />}
            {mutation.isLoading
              ? "处理中…"
              : mode === "login"
                ? "登录"
                : "创建账号"}
            {!mutation.isLoading ? <ArrowRight size={16} /> : null}
          </button>
        </form>
      </section>
    </main>
  );
}
