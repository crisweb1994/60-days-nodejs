import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCodes } from '../../common/constants/error-codes';
import { BusinessException } from '../../common/exceptions/business.exception';
import type { AppConfig } from '../../config/configuration';

// 从 GitHub 拿到的用户信息（已收窄成我们需要的字段）
export interface GithubUser {
  id: string; // GitHub 数字 id（转成字符串）
  login: string; // GitHub 用户名
  name: string | null;
  email: string | null;
}

/**
 * GitHub OAuth 的"对外通信层"——所有打 GitHub 的 HTTP 都在这里，方便测试时整体替换。
 * 业务逻辑（找/建用户、发本系统 token）在 AuthService.loginWithGithub。
 */
@Injectable()
export class GithubOAuthProvider {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private cfg() {
    return this.config.get('oauth.github', { infer: true });
  }

  // 没配 client id/secret 就视为"未启用 GitHub 登录"
  isConfigured(): boolean {
    const c = this.cfg();
    return Boolean(c.clientId && c.clientSecret);
  }

  // 第一步：构造 GitHub 授权页 URL（浏览器会被 302 到这里）
  getAuthorizeUrl(state: string): string {
    const c = this.cfg();
    const params = new URLSearchParams({
      client_id: c.clientId ?? '',
      redirect_uri: c.callbackUrl,
      scope: 'read:user user:email', // 要读用户基本信息 + 邮箱
      state, // 防 CSRF，回调时核对
      allow_signup: 'true',
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  // 第三步：拿回调里的 code 去换 GitHub access token。
  // ★ client_secret 只在这里（服务端）用，绝不下发到前端——这就是"授权码模式"的核心。
  async exchangeCodeForToken(code: string): Promise<string> {
    const c = this.cfg();
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code,
        redirect_uri: c.callbackUrl,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (!data.access_token) {
      throw new BusinessException(
        ErrorCodes.OAUTH_FAILED,
        'GitHub 授权码换取 token 失败',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return data.access_token;
  }

  // 第四步：用 GitHub token 拉用户资料 + 主邮箱（邮箱可能是私有的，要单独再查一次）
  async fetchGithubUser(githubToken: string): Promise<GithubUser> {
    const headers = {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'blog-api', // GitHub API 要求带 UA
    };
    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) {
      throw new BusinessException(
        ErrorCodes.OAUTH_FAILED,
        '拉取 GitHub 用户信息失败',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const u = (await userRes.json()) as {
      id: number;
      login: string;
      name: string | null;
      email: string | null;
    };

    let email = u.email;
    if (!email) {
      // 用户把邮箱设私有了：/user 不返回，要单独查 /user/emails，取已验证的主邮箱
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        email =
          emails.find((e) => e.primary && e.verified)?.email ??
          emails.find((e) => e.verified)?.email ??
          null;
      }
    }
    return { id: String(u.id), login: u.login, name: u.name, email };
  }
}
