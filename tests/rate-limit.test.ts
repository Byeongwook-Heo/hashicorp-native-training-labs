import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../server/rate-limit.js";

type Invocation = {
  status: number;
  nextCalled: boolean;
  body?: unknown;
  headers: Record<string, string>;
};

function invoke(
  middleware: ReturnType<typeof createRateLimiter>["middleware"],
  key: string,
): Invocation {
  const result: Invocation = {
    status: 200,
    nextCalled: false,
    headers: {},
  };
  const request = {
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get: (name: string) => (name.toLowerCase() === "x-test-key" ? key : undefined),
  } as unknown as Request;
  const response = {
    setHeader(name: string, value: string) {
      result.headers[name] = value;
      return this;
    },
    status(status: number) {
      result.status = status;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  } as unknown as Response;
  const next = (() => {
    result.nextCalled = true;
  }) as NextFunction;
  middleware(request, response, next);
  return result;
}

describe("bounded rate limiter", () => {
  it("caps key cardinality and fails closed through a shared overflow bucket", () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      maxKeys: 10,
      key: (request) => request.get("x-test-key") || "missing",
    });

    const results = Array.from({ length: 30 }, (_, index) =>
      invoke(limiter.middleware, `attacker-key-${index}`),
    );

    expect(limiter.size()).toBeLessThanOrEqual(10);
    expect(results.some((result) => result.status === 429)).toBe(true);
    expect(results.at(-1)).toMatchObject({
      status: 429,
      nextCalled: false,
    });
    expect(results.at(-1)?.headers).toMatchObject({
      "RateLimit-Limit": "1",
      "RateLimit-Remaining": "0",
    });

    limiter.reset();
    expect(limiter.size()).toBe(0);
    limiter.stop();
  });

  it("keeps an existing key's bucket after overflow begins", () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      maxKeys: 10,
      key: (request) => request.get("x-test-key") || "missing",
    });
    for (let index = 0; index < 20; index += 1) {
      invoke(limiter.middleware, `key-${index}`);
    }

    expect(invoke(limiter.middleware, "key-0")).toMatchObject({
      status: 429,
      nextCalled: false,
    });
    expect(limiter.size()).toBeLessThanOrEqual(10);
    limiter.stop();
  });
});
