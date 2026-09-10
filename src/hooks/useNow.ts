import { useSyncExternalStore } from "react";

/**
 * 共享的「当前时间」时钟。
 *
 * 相对时间文案（「x 分钟前」）需要定期重渲染才会更新。若每个组件各起一个
 * `setInterval`，N 张供应商卡片就是 N 个错峰定时器、N 次独立重渲染。这里按
 * 间隔分桶，同一间隔的所有订阅者共用一个定时器、拿到同一个时间戳。
 */

interface Bucket {
  listeners: Set<() => void>;
  now: number;
  timer: ReturnType<typeof setInterval> | null;
}

const buckets = new Map<number, Bucket>();

function getBucket(intervalMs: number): Bucket {
  let bucket = buckets.get(intervalMs);
  if (!bucket) {
    bucket = { listeners: new Set(), now: Date.now(), timer: null };
    buckets.set(intervalMs, bucket);
  }
  return bucket;
}

function subscribe(intervalMs: number, onStoreChange: () => void): () => void {
  const bucket = getBucket(intervalMs);
  bucket.listeners.add(onStoreChange);

  // 首个订阅者启动定时器。空转期间时间戳会停在最后一次 tick，
  // 所以这里同时把它刷新到当下，避免新订阅者读到过期值。
  if (bucket.timer === null) {
    bucket.now = Date.now();
    bucket.timer = setInterval(() => {
      bucket.now = Date.now();
      for (const listener of bucket.listeners) listener();
    }, intervalMs);
  }

  return () => {
    bucket.listeners.delete(onStoreChange);
    if (bucket.listeners.size === 0 && bucket.timer !== null) {
      clearInterval(bucket.timer);
      bucket.timer = null;
    }
  };
}

/**
 * 返回每 `intervalMs` 毫秒推进一次的时间戳，同间隔的调用方共用一个定时器。
 *
 * `enabled` 为 false 时不订阅（也不参与定时器），返回订阅时刻的时间戳。
 */
export function useNow(intervalMs: number, enabled = true): number {
  return useSyncExternalStore(
    (onStoreChange) =>
      enabled ? subscribe(intervalMs, onStoreChange) : () => {},
    () => (enabled ? getBucket(intervalMs).now : 0),
    () => 0,
  );
}
