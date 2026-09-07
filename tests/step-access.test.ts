import { describe, expect, it } from "vitest";
import { canAccessStep } from "../src/step-access.js";

const steps = [
  { id: "first" },
  { id: "second" },
  { id: "third" },
  { id: "last" }
];

describe("stage access by role", () => {
  it("lets an administrator open every valid stage without changing progress", () => {
    const noProgress = new Set<string>();

    expect(steps.map((_, index) => canAccessStep(index, steps, noProgress, "admin")))
      .toEqual([true, true, true, true]);
    expect(noProgress.size).toBe(0);
  });

  it.each(["learner", "instructor"] as const)(
    "keeps sequential access for %s users",
    (role) => {
      expect(canAccessStep(0, steps, new Set(), role)).toBe(true);
      expect(canAccessStep(2, steps, new Set(["first"]), role)).toBe(false);
      expect(canAccessStep(2, steps, new Set(["first", "second"]), role)).toBe(true);
    }
  );

  it("rejects invalid indexes even for administrators", () => {
    expect(canAccessStep(-1, steps, new Set(), "admin")).toBe(false);
    expect(canAccessStep(steps.length, steps, new Set(), "admin")).toBe(false);
    expect(canAccessStep(1.5, steps, new Set(), "admin")).toBe(false);
  });
});
