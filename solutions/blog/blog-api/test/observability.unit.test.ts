import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { HttpException, HttpStatus } from '@nestjs/common';

import { createLogger } from '../src/observability/logger';
import { requestContextStorage } from '../src/common/request-context';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { StructuredLoggerService } from '../src/observability/structured-logger.service';
import { ErrorReporter } from '../src/observability/error-reporter';

// Day 45 单元测试，分两块：
//   ① 结构化日志本身——JSON 形状 + requestId 经 CLS 自动关联（用 buffer 流收日志，确定性断言，不碰 stdout）；
//   ② AllExceptionsFilter 的错误上报边界——5xx 才推 Sentry（用假 reporter 断言），4xx 不推。
// 都不需要 DB / Redis / Nest app：纯函数式构造，跑得快、稳。

// 收集写入的日志行（pino 对普通 Writable 流是同步写，logger.info 返回时 lines 就有了）
function collectStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

test('结构化日志：输出是合法 JSON，自定义字段齐全', () => {
  const { stream, lines } = collectStream();
  const logger = createLogger({ level: 'info', pretty: false, stream });
  logger.info({ method: 'GET', url: '/x', status: 200, durationMs: 5 }, 'http request');

  const obj = JSON.parse(lines[0]);
  assert.equal(obj.method, 'GET');
  assert.equal(obj.url, '/x');
  assert.equal(obj.status, 200);
  assert.equal(obj.durationMs, 5);
  assert.equal(obj.msg, 'http request');
  assert.equal(obj.app, 'blog-api'); // 进程级 base 字段，采集后能按应用过滤
  // pino 默认用数字级别（info=30 / warn=40 / error=50），机器按 < / >= 切片比字符串快
  assert.equal(typeof obj.level, 'number');
});

test('requestId 关联：CLS 里的 requestId 经 mixin 自动挂到日志', () => {
  const { stream, lines } = collectStream();
  const logger = createLogger({ level: 'info', pretty: false, stream });
  // 模拟「在某请求的异步链里打日志」：RequestContextMiddleware 就是这样 .run 出上下文的
  requestContextStorage.run({ requestId: 'req-abc' }, () => {
    logger.info({ event: 'work' }, 'inside request');
  });

  const obj = JSON.parse(lines[0]);
  assert.equal(obj.requestId, 'req-abc'); // ★ 没有显式传，是 mixin 从 CLS 自动带上的
  assert.equal(obj.event, 'work');
});

test('CLS 外的日志不带 requestId（启动期日志不被污染）', () => {
  const { stream, lines } = collectStream();
  const logger = createLogger({ level: 'info', pretty: false, stream });
  logger.info({ event: 'startup' }, 'boot');

  const obj = JSON.parse(lines[0]);
  assert.equal('requestId' in obj, false); // 不在请求里 → mixin 返回 {} → 无 requestId 字段
});

test('日志脱敏：把整个 req 塞进来，敏感头被盖成 [REDACTED]', () => {
  const { stream, lines } = collectStream();
  const logger = createLogger({ level: 'info', pretty: false, stream });
  logger.info(
    { req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1' } } },
    'debug dump',
  );

  const obj = JSON.parse(lines[0]);
  assert.equal(obj.req.headers.authorization, '[REDACTED]');
  assert.equal(obj.req.headers.cookie, '[REDACTED]');
});

// ── 错误上报边界：假 reporter 断言「5xx 才 capture」 ──────────────────────
class FakeReporter extends ErrorReporter {
  captured: { exception: unknown; context?: Record<string, unknown> }[] = [];
  capture(exception: unknown, context?: Record<string, unknown>): void {
    this.captured.push({ exception, context });
  }
}

function makeHost(req: Record<string, unknown>) {
  let status = 0;
  let body: Record<string, unknown> | undefined;
  const res: Record<string, unknown> = {
    status(s: number) {
      status = s;
      return res;
    },
    json(p: Record<string, unknown>) {
      body = p;
      return res;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  };
  return { host, getStatus: () => status, getBody: () => body };
}

test('AllExceptionsFilter：5xx 未知异常 → 推 Sentry + 安全文案（不泄露 message）', () => {
  const reporter = new FakeReporter();
  const filter = new AllExceptionsFilter(new StructuredLoggerService(), reporter);
  const { host, getStatus, getBody } = makeHost({
    method: 'GET',
    url: '/posts/debug/boom',
    headers: { 'x-request-id': 'r1' },
  });
  const boom = new Error('boom! 这条 message 不应该被客户端看到');

  filter.catch(boom, host as never);

  assert.equal(getStatus(), 500);
  const body = getBody()!;
  assert.equal(body.message, '服务器内部错误');
  // ★ 原始异常的 message 绝不能漏到响应体
  assert.equal(String(body.message).includes('boom'), false);
  assert.equal(body.requestId, 'r1');
  // ★ 5xx 推了一份给 reporter
  assert.equal(reporter.captured.length, 1);
  assert.equal(reporter.captured[0].exception, boom);
  assert.equal(reporter.captured[0].context?.requestId, 'r1');
});

test('AllExceptionsFilter：4xx 不推 Sentry（避免告警噪音）', () => {
  const reporter = new FakeReporter();
  const filter = new AllExceptionsFilter(new StructuredLoggerService(), reporter);
  const { host, getStatus, getBody } = makeHost({
    method: 'GET',
    url: '/posts/abc',
    headers: {},
  });
  // NotFoundException 是 HttpException(404)：客户端责任（id 不存在），不该污染 5xx 告警
  const notFound = new HttpException(
    { code: 'POST_NOT_FOUND', message: '文章不存在' },
    HttpStatus.NOT_FOUND,
  );

  filter.catch(notFound, host as never);

  assert.equal(getStatus(), 404);
  assert.equal(getBody()?.message, '文章不存在');
  assert.equal(reporter.captured.length, 0); // ★ 4xx 不上报
});

test('AllExceptionsFilter：5xx 的 HttpException（如 503）也推 Sentry', () => {
  const reporter = new FakeReporter();
  const filter = new AllExceptionsFilter(new StructuredLoggerService(), reporter);
  const { host, getStatus } = makeHost({ method: 'GET', url: '/health/ready', headers: {} });
  const unavailable = new HttpException('Service Unavailable', HttpStatus.SERVICE_UNAVAILABLE);

  filter.catch(unavailable, host as never);

  assert.equal(getStatus(), 503);
  assert.equal(reporter.captured.length, 1); // 503 虽是 HttpException，仍是 5xx → 推
});
