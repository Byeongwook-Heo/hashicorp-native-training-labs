import { describe, expect, it } from "vitest";
import {
  createCourseRuntime,
  DEFAULT_COURSE_ID,
  resolveCourseDefinition,
  TERRAFORM_COURSE_ID
} from "../server/course-registry.js";
import { publicCourseDefinition } from "../server/course-definition.js";
import { MockVaultRuntime } from "../server/mock-runtime.js";

describe("course registry", () => {
  it("selects the complete Vault course by default", () => {
    const course = resolveCourseDefinition(undefined);

    expect(course.id).toBe(DEFAULT_COURSE_ID);
    expect(course.runtimeKind).toBe("vault-native");
    expect(course.labs).toHaveLength(7);
    expect(course.steps).toHaveLength(30);
    expect(new Set(course.steps.map((step) => step.id)).size).toBe(30);
  });

  it("publishes metadata without server-only validation commands", () => {
    const course = resolveCourseDefinition(DEFAULT_COURSE_ID);
    const publicCourse = publicCourseDefinition(course);

    expect(publicCourse).toEqual({
      id: "vault-foundations",
      title: "HashiCorp Vault 실무 기초",
      summary: expect.any(String),
      level: "초급–중급",
      durationMinutes: 140,
      runtimeKind: "vault-native",
      labCount: 7,
      stepCount: 30
    });
    expect(publicCourse).not.toHaveProperty("steps");
    expect(publicCourse).not.toHaveProperty("copy");
  });

  it("registers the complete Terraform course and native runtime kind", () => {
    const course = resolveCourseDefinition(TERRAFORM_COURSE_ID);

    expect(course.id).toBe("terraform-foundations");
    expect(course.runtimeKind).toBe("terraform-native");
    expect(course.durationMinutes).toBe(225);
    expect(course.labs).toHaveLength(8);
    expect(course.steps).toHaveLength(34);
    expect(new Set(course.steps.map((step) => step.id)).size).toBe(34);
    expect(course.labs.map((lab) => lab.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("fails closed for an unknown or empty configured course", () => {
    expect(() => resolveCourseDefinition("unknown-course")).toThrow(
      "지원하지 않는 COURSE_ID"
    );
    expect(() => resolveCourseDefinition("")).toThrow(
      "지원하지 않는 COURSE_ID"
    );
  });

  it("constructs the selected runtime through the registry factory seam", () => {
    const runtime = createCourseRuntime(
      resolveCourseDefinition(DEFAULT_COURSE_ID),
      { mock: true, maxSessions: 4 }
    );

    expect(runtime).toBeInstanceOf(MockVaultRuntime);
  });
});
