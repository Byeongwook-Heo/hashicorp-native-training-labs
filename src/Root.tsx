import { lazy, Suspense, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Login, type AuthUser } from "./Login";
import type { CoursePayload } from "./types";

const LabApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
const AdminDashboard = lazy(() => import("./AdminDashboard").then((module) => ({ default: module.AdminDashboard })));

const adminPath = () => window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");

const defaultCourse: CoursePayload = {
  course: {
    id: "vault-foundations",
    title: "HashiCorp Vault 실무 기초",
    summary: "비밀 관리와 정책, AppRole, Transit, 감사와 PKI까지 네이티브 환경에서 익히는 실습 과정입니다.",
    level: "초급–중급",
    durationMinutes: 140,
    runtimeKind: "vault-native",
    labCount: 7,
    stepCount: 30
  },
  labs: []
};

function normalizeCoursePayload(value: unknown): CoursePayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<CoursePayload>;
  const course = payload.course;
  if (
    !course || typeof course !== "object" ||
    typeof course.id !== "string" ||
    typeof course.title !== "string" ||
    typeof course.summary !== "string" ||
    typeof course.level !== "string" ||
    typeof course.durationMinutes !== "number" ||
    (course.runtimeKind !== "vault-native" && course.runtimeKind !== "terraform-native") ||
    typeof course.labCount !== "number" ||
    typeof course.stepCount !== "number" ||
    !Array.isArray(payload.labs)
  ) return null;
  return payload as CoursePayload;
}

function normalizeUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    typeof user.displayName !== "string" ||
    (user.role !== "learner" && user.role !== "instructor" && user.role !== "admin")
  ) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    cohortIds: Array.isArray(user.cohortIds)
      ? user.cohortIds.filter((item): item is string => typeof item === "string")
      : []
  };
}

export function Root() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [route, setRoute] = useState<"lab" | "admin">(() => adminPath() ? "admin" : "lab");
  const [courseProfile, setCourseProfile] = useState<CoursePayload>(defaultCourse);

  useEffect(() => {
    const controller = new AbortController();
    const authRequest = fetch("/api/auth/me", {
      credentials: "include",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error("인증 상태를 확인하지 못했습니다.");
      const body = await response.json();
      return normalizeUser(body.user);
    });
    const courseRequest = fetch("/api/course", {
      credentials: "include",
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) return null;
      return normalizeCoursePayload(await response.json());
    }).catch(() => null);
    void Promise.all([authRequest, courseRequest])
      .then(([authenticated, profile]) => {
        if (profile) setCourseProfile(profile);
        setUser(authenticated);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setUser(null);
      });
    const updateRoute = () => setRoute(adminPath() ? "admin" : "lab");
    window.addEventListener("popstate", updateRoute);
    return () => {
      controller.abort();
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  useEffect(() => {
    if (user?.role === "learner" && route === "admin") {
      window.history.replaceState({}, "", "/");
      setRoute("lab");
    }
  }, [route, user]);

  const navigate = (next: "lab" | "admin") => {
    const path = next === "admin" ? "/admin" : "/";
    window.history.pushState({}, "", path);
    setRoute(next);
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" }
    }).catch(() => undefined);
    window.history.replaceState({}, "", "/");
    setRoute("lab");
    setUser(null);
  };

  if (user === undefined) {
    return <main className="boot"><LoaderCircle className="spin" /><p>보안 세션을 확인하고 있습니다…</p></main>;
  }

  if (!user) {
    return <Login course={courseProfile.course} onAuthenticated={(authenticated) => {
      setUser(normalizeUser(authenticated));
      if (adminPath() && authenticated.role !== "learner") setRoute("admin");
      else navigate("lab");
    }} />;
  }

  if (route === "admin") {
    if (user.role === "learner") return null;
    return <Suspense fallback={<main className="boot"><LoaderCircle className="spin" /><p>운영 화면을 불러오는 중입니다…</p></main>}>
      <AdminDashboard
        instructorName={user.displayName}
        role={user.role}
        labName={courseProfile.course.runtimeKind === "terraform-native" ? "Terraform Lab" : "Vault Lab"}
        brandMark={courseProfile.course.runtimeKind === "terraform-native" ? "T" : "V"}
        onOpenLab={() => navigate("lab")}
        onSignedOut={() => void signOut()}
      />
    </Suspense>;
  }

  return <Suspense fallback={<main className="boot"><LoaderCircle className="spin" /><p>실습 화면을 불러오는 중입니다…</p></main>}>
    <LabApp
      user={user}
      initialCourse={courseProfile}
      onSignOut={() => void signOut()}
      onOpenAdmin={user.role === "learner" ? undefined : () => navigate("admin")}
    />
  </Suspense>;
}
