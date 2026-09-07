import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeTerminalChannel
} from "./native-runtime.js";
import type { Step } from "./curriculum.js";

export type CourseRuntimeKind = "vault-native" | "terraform-native";

export type CourseLab = {
  id: number;
  name: string;
  time: string;
  level: string;
  description: string;
  outcomes: readonly string[];
};

export type CourseMetadata = {
  id: string;
  title: string;
  summary: string;
  level: string;
  durationMinutes: number;
};

export type CourseCopy = {
  serviceName: string;
  subjectName: string;
  validationFailure: string;
  mockTerminalBanner: string;
  terminalPrompt: string;
  mockAdminEmail: string;
};

export type CourseDefinition = CourseMetadata & {
  runtimeKind: CourseRuntimeKind;
  labs: readonly CourseLab[];
  steps: readonly Step[];
  copy: CourseCopy;
};

export type PublicCourseDefinition = CourseMetadata & {
  runtimeKind: CourseRuntimeKind;
  labCount: number;
  stepCount: number;
};

export type LabSessionInfo = {
  id: string;
  slot: string;
  address: string;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
};

/**
 * Runtime contract used by the course-independent HTTP and WebSocket layer.
 * A Terraform runtime can implement this interface without changing the API
 * handlers or importing the Vault runtime implementation.
 */
export interface LabRuntime {
  initialize(): Promise<void>;
  getOrCreate(id: string): Promise<LabSessionInfo>;
  get(id: string): Promise<LabSessionInfo | null>;
  reset(id: string): Promise<LabSessionInfo>;
  destroy(id: string): Promise<boolean>;
  extend(id: string, additionalMs: number): Promise<LabSessionInfo>;
  execute(
    id: string,
    argv: readonly string[],
    options: NativeCommandOptions
  ): Promise<NativeCommandResult>;
  openTerminal?(id: string): Promise<NativeTerminalChannel>;
  startJanitor(intervalMs?: number): () => void;
  close(): Promise<void>;
}

export type CourseRuntimeFactoryOptions = {
  mock: boolean;
  maxSessions: number;
};

export type CourseRuntimeFactory = (
  options: CourseRuntimeFactoryOptions
) => LabRuntime;

export function publicCourseDefinition(
  course: CourseDefinition
): PublicCourseDefinition {
  return {
    id: course.id,
    title: course.title,
    summary: course.summary,
    level: course.level,
    durationMinutes: course.durationMinutes,
    runtimeKind: course.runtimeKind,
    labCount: course.labs.length,
    stepCount: course.steps.length
  };
}
