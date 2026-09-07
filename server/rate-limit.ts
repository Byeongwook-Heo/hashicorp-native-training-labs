import type { Request, RequestHandler, Response } from "express";

type Bucket = {
  count: number;
  resetAt: number;
};

export type RateLimitOptions = {
  windowMs: number;
  max: number;
  /**
   * Bound memory even when an attacker supplies a high-cardinality key such as
   * a forged user-agent or email address. New keys share a fail-closed overflow
   * bucket after this limit is reached.
   */
  maxKeys?: number;
  key?: (request: Request, response: Response) => string;
  message?: string;
  skip?: (request: Request, response: Response) => boolean;
};

export type RateLimiter = {
  middleware: RequestHandler;
  reset: (key?: string) => void;
  size: () => number;
  stop: () => void;
};

const OVERFLOW_KEY = Symbol("rate-limit-overflow");
const MAX_KEY_LENGTH = 512;

function defaultKey(request: Request, _response?: Response) {
  // req.ip respects Express' configured trust-proxy policy.
  return request.ip || request.socket.remoteAddress || "unknown";
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  if (!Number.isFinite(options.windowMs) || options.windowMs < 1_000) {
    throw new Error("rate limit windowMs는 1초 이상이어야 합니다.");
  }
  if (!Number.isInteger(options.max) || options.max < 1) {
    throw new Error("rate limit max는 1 이상의 정수여야 합니다.");
  }
  const maxKeys = options.maxKeys ?? 10_000;
  if (!Number.isInteger(maxKeys) || maxKeys < 10 || maxKeys > 100_000) {
    throw new Error("rate limit maxKeys는 10 이상 100000 이하의 정수여야 합니다.");
  }

  const buckets = new Map<string | typeof OVERFLOW_KEY, Bucket>();
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.min(options.windowMs, 60_000));
  interval.unref();

  const middleware: RequestHandler = (request, response, next) => {
    if (options.skip?.(request, response)) {
      next();
      return;
    }
    const rawKey = String((options.key ?? defaultKey)(request, response)).slice(
      0,
      MAX_KEY_LENGTH,
    );
    const now = Date.now();
    const rawKeyCapacity = maxKeys - (buckets.has(OVERFLOW_KEY) ? 0 : 1);
    const key =
      buckets.has(rawKey) || buckets.size < rawKeyCapacity
        ? rawKey
        : OVERFLOW_KEY;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, options.max - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    response.setHeader("RateLimit-Limit", String(options.max));
    response.setHeader("RateLimit-Remaining", String(remaining));
    response.setHeader("RateLimit-Reset", String(resetSeconds));
    if (bucket.count > options.max) {
      response.setHeader("Retry-After", String(resetSeconds));
      response.status(429).json({
        error:
          options.message ??
          "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        retryAfterSeconds: resetSeconds,
      });
      return;
    }
    next();
  };

  return {
    middleware,
    reset(key) {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
    stop() {
      clearInterval(interval);
      buckets.clear();
    },
  };
}
