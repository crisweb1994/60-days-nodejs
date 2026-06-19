import { AsyncLocalStorage } from 'node:async_hooks';

// 缓存命中状态：X-Cache 响应头的取值
export type CacheState = 'HIT' | 'MISS' | 'BYPASS';

/**
 * 请求级上下文（CLS / Continuation-Local Storage）。
 *
 * 要解决的问题：PostsService 是单例（整个应用共享一个实例），但「这次请求到底命中缓存没」
 * 是「每个请求」的属性。我们想让 service 把 HIT/MISS 写进某个地方，再由拦截器把它写成
 * X-Cache 响应头。怎么把「请求级」的状态，从单例 service 传到 HTTP 边界？
 *
 * 两条路：
 *   1. 把 service 标成请求级（@Scope(REQUEST)）——能拿到 req，但单例变多例，
 *      每个请求重新 new 一遍整个依赖图，性能和心智负担都不值。
 *   2. AsyncLocalStorage（CLS）——Node 内置的「按异步调用链传递的上下文」。
 *      中间件在最外层 .run(store, next) 开一个上下文，这条请求后续所有的
 *      await / Promise / 定时器回调都能 getStore() 拿到同一份 store。
 *      不改任何 provider 的作用域，零额外实例化。这就是 nestjs-cls 这类库的原理。
 *
 * 我们用 2。它和项目里「request-id 存在 req 上、拦截器读 req」是同一个心智模型，
 * 只是存储后端从 Express 的 req 换成了 Node 的 ALS（因为这里写状态的是 service，而 service 看不到 req）。
 */
interface RequestContext {
  cache?: CacheState;
  cacheKey?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** 读当前请求的上下文（没有上下文时返回空对象，调用方可安全读字段）。 */
export function getRequestContext(): RequestContext {
  return requestContextStorage.getStore() ?? {};
}

/** service 用：把这次读的缓存命中状态写进当前请求的上下文。 */
export function setCacheState(state: CacheState, key?: string): void {
  const store = requestContextStorage.getStore();
  if (!store) return; // 没有请求上下文（比如单元测试直接调 service）——直接忽略，不影响业务
  store.cache = state;
  if (key) store.cacheKey = key;
}
