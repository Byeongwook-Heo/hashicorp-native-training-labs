export type StepAccessRole = "learner" | "instructor" | "admin";

type StepIdentity = {
  id: string;
};

export function canAccessStep(
  index: number,
  steps: readonly StepIdentity[],
  resolvedStepIds: ReadonlySet<string>,
  role?: StepAccessRole
) {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return false;
  if (role === "admin") return true;
  return index === 0 || steps.slice(0, index).every((item) => resolvedStepIds.has(item.id));
}
