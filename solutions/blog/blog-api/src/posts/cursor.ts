// ============================================================================
// 游标（cursor）编解码 —— keyset 分页的"书签"
// ----------------------------------------------------------------------------
// 游标对客户端是**不透明**的：它不该去解析、拼接，只负责把上一页返回的 nextCursor
// 原样带回来。内部实现其实就是 "排序值 + id" 的 base64url 编码——keyset 分页要靠这
// 两样定位"上一页最后一条"，从而 WHERE (sortVal, id) < (cursorVal, cursorId)。
//
// 为什么要 id：排序字段（如 createdAt）可能重复，单靠它无法唯一定位边界，会漏行 /
// 重复行。补 id 形成全序，游标才稳。
// ============================================================================

export interface CursorPayload {
  // 排序字段在游标那一行的值，序列化成字符串：
  //   - 日期字段（createdAt/updatedAt）存 ISO 字符串
  //   - 文本字段（title）存原文
  v: string;
  // 次级排序键 / 唯一定位（Post 的 UUID）
  id: string;
}

// 编码成不透明 token。base64url 不含 + / =，可安全放进 URL query。
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// 解码。任何畸形输入（乱码、被截断、JSON 不合法、字段缺失）都返回 null，
// 由调用方决定怎么处理（本项目在 Service 里转成 400）。解析用户输入永远要防御。
export function decodeCursor(token: string): CursorPayload | null {
  try {
    const obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (obj && typeof obj.v === 'string' && typeof obj.id === 'string') {
      return { v: obj.v, id: obj.id };
    }
    return null;
  } catch {
    return null;
  }
}
