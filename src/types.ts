export type Step = {
  id: string;
  lab: number;
  title: string;
  objective: string;
  description: string;
  concept: string;
  command: string;
  expected: string;
  hint: string;
  troubleshooting: string[];
  success: string;
};

export type RuntimeKind = "vault-native" | "terraform-native";

export type CourseDefinition = {
  id: string;
  title: string;
  summary: string;
  level: string;
  durationMinutes: number;
  runtimeKind: RuntimeKind;
  labCount: number;
  stepCount: number;
};

export type CourseLab = {
  id: number;
  name: string;
  time: string;
  level: string;
  description: string;
  outcomes: readonly string[];
};

export type CoursePayload = {
  course: CourseDefinition;
  labs: CourseLab[];
};

export type ValidationCheck = {
  label: string;
  ok: boolean;
  detail?: string;
};

export type CourseReadiness = "active" | "ready" | "requires-integration";
export type CourseDelivery = "native" | "integration" | "dedicated";

export type CourseTrack = {
  id: string;
  title: string;
  summary: string;
  level: string;
  durationMinutes: number;
  delivery: CourseDelivery;
  readiness: CourseReadiness;
  outcomes: string[];
  requirements: string[];
};

export type CourseCatalog = {
  version: number;
  updatedAt: string;
  tracks: CourseTrack[];
};
