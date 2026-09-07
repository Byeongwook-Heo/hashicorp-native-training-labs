import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen, Check, CheckCircle2, ChevronDown, CircleAlert, Clock3, Copy,
  FastForward, LayoutDashboard, Library, Lightbulb, ListChecks, LoaderCircle, LockKeyhole, LogOut,
  Menu, PanelLeftClose, Play, RefreshCw, RotateCcw, Send, ServerCog, Target, TerminalSquare, Trophy, UserRound, X
} from "lucide-react";
import { Terminal, type TerminalInputRequest } from "./Terminal";
import { copyText } from "./copy-text";
import { canAccessStep } from "./step-access";
import type {
  CourseCatalog,
  CourseDefinition,
  CourseLab,
  CoursePayload,
  Step,
  ValidationCheck
} from "./types";
import type { AuthUser } from "./Login";

type Feedback = { type: "success" | "error" | "skipped"; message: string; checks?: ValidationCheck[] };
type AppProps = {
  user?: AuthUser;
  initialCourse?: CoursePayload;
  onSignOut?: () => void;
  onOpenAdmin?: () => void;
};

const fallbackCourse: CourseDefinition = {
  id: "vault-foundations",
  title: "HashiCorp Vault 실무 기초",
  summary: "Vault의 핵심 개념부터 운영 자동화까지 네이티브 환경에서 실습합니다.",
  level: "초급–중급",
  durationMinutes: 140,
  runtimeKind: "vault-native",
  labCount: 7,
  stepCount: 30
};

const storageKeys = (courseId: string) => ({
  completed: `lab:v1:${courseId}:completed`,
  skipped: `lab:v1:${courseId}:skipped`,
  browserSession: `lab:v1:${courseId}:browser-session`
});

const readStoredList = (key: string) => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
};

const getSession = (courseId: string) => {
  const key = storageKeys(courseId).browserSession;
  const existing = localStorage.getItem(key);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((n) => n.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(key, id); } catch { /* in-memory session still works */ }
  return id;
};

const storeList = (key: string, values: string[]) => {
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* keep current in-memory state */ }
};

const focusableElements = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"
)).filter((element) => element.getAttribute("aria-hidden") !== "true");

export function App({ user, initialCourse, onSignOut, onOpenAdmin }: AppProps) {
  const [course, setCourse] = useState<CourseDefinition>(initialCourse?.course || fallbackCourse);
  const [labs, setLabs] = useState<CourseLab[]>(initialCourse?.labs || []);
  const [session, setSession] = useState(() => getSession(initialCourse?.course.id || fallbackCourse.id));
  const [steps, setSteps] = useState<Step[]>([]);
  const [active, setActive] = useState(0);
  const [completed, setCompleted] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [hint, setHint] = useState(false);
  const [troubleshooting, setTroubleshooting] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [copiedStep, setCopiedStep] = useState("");
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [mobilePane, setMobilePane] = useState<"guide" | "terminal">("guide");
  const [mobileStepsOpen, setMobileStepsOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<CourseCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const toastTimer = useRef<number | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const mobileActionsButtonRef = useRef<HTMLButtonElement>(null);
  const catalogDialogRef = useRef<HTMLElement>(null);
  const catalogReturnFocusRef = useRef<HTMLElement | null>(null);

  const loadSession = async () => {
    setLoadError("");
    try {
      const response = await fetch("/api/session", { headers: { "x-lab-session": session } });
      const data = await response.json();
      if (!response.ok || !data.ready) throw new Error(data.error || "실습 환경을 준비하지 못했습니다.");
      const curriculum: Step[] = data.steps || [];
      const loadedCourse: CourseDefinition = data.course || course;
      const loadedLabs: CourseLab[] = Array.isArray(data.labs) ? data.labs : labs;
      setCourse(loadedCourse);
      setLabs(loadedLabs);
      if (loadedCourse.id !== course.id) setSession(getSession(loadedCourse.id));
      setSteps(curriculum);
      const validIds = new Set(curriculum.map((item) => item.id));
      const progress = data.progress;
      const keys = storageKeys(loadedCourse.id);
      const storedCompleted = readStoredList(keys.completed);
      const storedSkipped = readStoredList(keys.skipped);
      const serverCompleted = progress?.passedStepIds || progress?.completed || [];
      const serverSkipped = progress?.skippedStepIds || progress?.skipped || [];
      const sourceCompleted = progress ? serverCompleted : storedCompleted;
      const sourceSkipped = progress ? serverSkipped : storedSkipped;
      const rawCompleted = [...new Set<string>(sourceCompleted)].filter((id) => validIds.has(id));
      const rawSkipped = [...new Set<string>(sourceSkipped)].filter((id) => validIds.has(id) && !rawCompleted.includes(id));
      const normalizedCompleted: string[] = [];
      const normalizedSkipped: string[] = [];
      for (const item of curriculum) {
        if (rawCompleted.includes(item.id)) normalizedCompleted.push(item.id);
        else if (rawSkipped.includes(item.id)) normalizedSkipped.push(item.id);
        else break;
      }
      setCompleted(normalizedCompleted);
      setSkipped(normalizedSkipped);
      storeList(keys.completed, normalizedCompleted);
      storeList(keys.skipped, normalizedSkipped);
      setReady(true);
    } catch (error) {
      setLoadError((error as Error).message);
      setReady(false);
    }
  };

  useEffect(() => {
    void loadSession();
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => {
      clearInterval(timer);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, [session]);

  useEffect(() => {
    if (!mobileActionsOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!mobileActionsRef.current?.contains(event.target as Node)) setMobileActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileActionsOpen(false);
      mobileActionsButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileActionsOpen]);

  useEffect(() => {
    if (!catalogOpen) return;
    const dialog = catalogDialogRef.current;
    if (!dialog) return;
    const frame = window.requestAnimationFrame(() => {
      (focusableElements(dialog)[0] || dialog).focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCatalogOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      const returnTarget = catalogReturnFocusRef.current;
      catalogReturnFocusRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [catalogOpen]);

  const step = steps[active];
  const currentLab = labs.find((item) => item.id === step?.lab) || labs[0] || {
    id: step?.lab || 1,
    name: "실습 과정",
    time: "",
    level: course.level,
    description: course.summary,
    outcomes: []
  };
  const isTerraform = course.runtimeKind === "terraform-native";
  const labName = isTerraform ? "Terraform Lab" : "Vault Lab";
  const brandMark = isTerraform ? "T" : "V";
  const subjectName = isTerraform ? "Terraform" : "Vault";
  const isAdmin = user?.role === "admin";
  const resolvedIds = useMemo(() => new Set([...completed, ...skipped]), [completed, skipped]);
  const canAccess = (index: number) => canAccessStep(index, steps, resolvedIds, user?.role);
  const resolvedCount = steps.filter((item) => resolvedIds.has(item.id)).length;
  const progressPercent = steps.length ? (resolvedCount / steps.length) * 100 : 0;
  const time = useMemo(() => new Date(seconds * 1000).toISOString().slice(11, 19), [seconds]);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  };

  const openCatalog = async (returnFocus?: HTMLElement | null) => {
    if (!catalogOpen) {
      catalogReturnFocusRef.current = returnFocus
        || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    }
    setCatalogOpen(true);
    if (catalog) return;
    setCatalogError("");
    try {
      const response = await fetch("/api/content/catalog", { credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "과정 카탈로그를 불러오지 못했습니다.");
      setCatalog(data.catalog || data);
    } catch (error) {
      setCatalogError((error as Error).message);
    }
  };

  const goToStep = (index: number) => {
    if (checking) {
      showToast("현재 단계 검증이 끝날 때까지 잠시 기다려 주세요.", "error");
      return;
    }
    if (!canAccess(index)) {
      showToast("이전 단계를 성공하거나 스킵해야 열 수 있습니다.", "error");
      return;
    }
    const changesLab = steps[index]?.lab !== step?.lab;
    setActive(index);
    setHint(false);
    setTroubleshooting(false);
    setFeedback(null);
    setMobileStepsOpen(false);
    if (changesLab) setOverviewOpen(true);
  };

  const copyCommand = async () => {
    if (!step?.command) return;
    try {
      await copyText(step.command);
      setCopiedStep(step.id);
      showToast("명령어를 클립보드에 복사했습니다.");
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopiedStep(""), 1800);
    } catch {
      showToast("복사에 실패했습니다. 명령어를 직접 선택해 주세요.", "error");
    }
  };

  const validate = async () => {
    if (!step || checking) return;
    setChecking(true);
    try {
      const response = await fetch(`/api/validate/${step.id}`, { method: "POST", headers: { "x-lab-session": session } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "검증 요청에 실패했습니다.");
      setFeedback({ type: data.ok ? "success" : "error", message: data.message, checks: data.checks });
      if (data.ok) {
        const nextCompleted = completed.includes(step.id) ? completed : [...completed, step.id];
        const nextSkipped = skipped.filter((id) => id !== step.id);
        setCompleted(nextCompleted);
        setSkipped(nextSkipped);
        const keys = storageKeys(course.id);
        storeList(keys.completed, nextCompleted);
        storeList(keys.skipped, nextSkipped);
      }
    } catch (error) {
      setFeedback({ type: "error", message: (error as Error).message });
    } finally {
      setChecking(false);
    }
  };

  const skipStep = async () => {
    if (!step || completed.includes(step.id)) return;
    if (!confirm(`“${step.title}” 단계를 스킵할까요?\n\n완료로 기록되지 않지만 다음 단계가 열립니다. 나중에 다시 돌아와 검증할 수 있습니다.`)) return;
    setChecking(true);
    try {
      const response = await fetch(`/api/auth/progress/${step.id}/skip`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-lab-session": session },
        body: JSON.stringify({ reason: "learner-request" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "스킵 기록을 저장하지 못했습니다.");
      const nextSkipped = skipped.includes(step.id) ? skipped : [...skipped, step.id];
      setSkipped(nextSkipped);
      storeList(storageKeys(course.id).skipped, nextSkipped);
      setFeedback({ type: "skipped", message: "이 단계는 스킵 처리되었습니다. 언제든 돌아와 실습하고 검증할 수 있습니다." });
    } catch (error) {
      showToast((error as Error).message, "error");
    } finally {
      setChecking(false);
    }
  };

  const sendToTerminal = () => {
    if (!step?.command) return;
    setMobilePane("terminal");
    window.requestAnimationFrame(() => {
      const request: TerminalInputRequest = {
        command: step.command,
        execute: false
      };
      window.dispatchEvent(new CustomEvent("training-lab:terminal-input", {
        detail: request
      }));
      if (request.result?.ok) {
        showToast("명령을 터미널에 입력했습니다. 내용을 확인한 뒤 Enter를 누르세요.");
      } else if (request.result?.reason === "not-connected") {
        showToast("터미널이 아직 연결되지 않았습니다. 재연결한 뒤 다시 시도해 주세요.", "error");
      } else {
        showToast("터미널로 명령을 보내지 못했습니다. 재연결한 뒤 다시 시도해 주세요.", "error");
      }
    });
  };

  const reset = async () => {
    if (!confirm("현재 실습 환경과 모든 완료·스킵 기록이 삭제됩니다. 초기화할까요?")) return;
    setReady(false);
    try {
      const response = await fetch("/api/reset", { method: "POST", headers: { "x-lab-session": session } });
      if (!response.ok) throw new Error("환경 초기화에 실패했습니다.");
      setCompleted([]);
      setSkipped([]);
      const keys = storageKeys(course.id);
      localStorage.removeItem(keys.completed);
      localStorage.removeItem(keys.skipped);
      setFeedback(null);
      setActive(0);
      setSeconds(0);
      setHint(false);
      setTroubleshooting(false);
      setOverviewOpen(true);
      setCopiedStep("");
      setReconnectKey((value) => value + 1);
      setReady(true);
      showToast(`새로운 ${subjectName} 환경이 준비되었습니다.`);
    } catch (error) {
      setReady(true);
      showToast((error as Error).message, "error");
    }
  };

  if (!step) {
    return <main className="boot">
      {loadError ? <><CircleAlert /><h1>환경을 준비하지 못했습니다</h1><p>{loadError}</p><button onClick={() => void loadSession()}><RefreshCw />다시 시도</button></> :
        <><LoaderCircle className="spin" /><p>개인 {subjectName} 환경을 준비하고 있습니다…</p><small>Docker 없이 격리된 네이티브 실습 세션을 생성하고 있습니다.</small></>}
    </main>;
  }

  const isLastStep = active === steps.length - 1;
  const currentResolved = resolvedIds.has(step.id);

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">{brandMark}</span><strong>{labName}</strong></div>
      <div className="current"><span>현재 랩 {step.lab} / {labs.length}</span><strong>{currentLab.name}</strong></div>
      <div className="top-actions">
        <span className="timer"><Clock3 />{time}</span>
        <span className={`environment ${ready ? "online" : ""}`} role="status"><i /><span>{ready ? "환경 준비 완료" : "환경 준비 중"}</span></span>
        <button className="secondary catalog-button" onClick={(event) => void openCatalog(event.currentTarget)}><Library />과정 카탈로그</button>
        <button className="secondary" onClick={reset}><RotateCcw />환경 초기화</button>
        {user?.role !== "learner" && onOpenAdmin && <button className="secondary admin-link" onClick={onOpenAdmin}><LayoutDashboard />운영 화면</button>}
        {user && <span className="app-user"><UserRound /><span><strong>{user.displayName}</strong><small>{user.role === "learner" ? "교육생" : user.role === "instructor" ? "강사" : "관리자"}</small></span></span>}
        {onSignOut && <button className="icon-action" aria-label="로그아웃" title="로그아웃" onClick={onSignOut}><LogOut /></button>}
        <div className="mobile-actions" ref={mobileActionsRef}>
          <button
            ref={mobileActionsButtonRef}
            className="mobile-actions-toggle"
            aria-label="작업 메뉴"
            aria-expanded={mobileActionsOpen}
            aria-controls="mobile-actions-panel"
            onClick={() => setMobileActionsOpen((value) => !value)}
          >
            <Menu />
          </button>
          {mobileActionsOpen && <div id="mobile-actions-panel" className="mobile-actions-panel" role="group" aria-label="작업 메뉴">
            {user && <div className="mobile-actions-user"><UserRound /><span><strong>{user.displayName}</strong><small>{user.role === "learner" ? "교육생" : user.role === "instructor" ? "강사" : "관리자"}</small></span></div>}
            <button onClick={() => {
              setMobileActionsOpen(false);
              void openCatalog(mobileActionsButtonRef.current);
            }}><Library />과정 카탈로그</button>
            <button onClick={() => {
              setMobileActionsOpen(false);
              window.requestAnimationFrame(() => mobileActionsButtonRef.current?.focus());
              void reset();
            }}><RotateCcw />환경 초기화</button>
            {user?.role !== "learner" && onOpenAdmin && <button onClick={() => {
              setMobileActionsOpen(false);
              onOpenAdmin();
            }}><LayoutDashboard />운영 화면</button>}
            {onSignOut && <button onClick={() => {
              setMobileActionsOpen(false);
              onSignOut();
            }}><LogOut />로그아웃</button>}
          </div>}
        </div>
      </div>
    </header>

    <aside className="sidebar">
      <div className="course-progress">
        <div><span>전체 진도</span><strong>{resolvedCount}<small> / {steps.length}</small></strong></div>
        <div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
        <p><i className="complete-key" />완료 {completed.length}<i className="skip-key" />스킵 {skipped.length}</p>
        <small>{isAdmin
          ? "관리자는 완료 여부와 관계없이 모든 단계를 직접 열 수 있습니다."
          : "성공 또는 스킵 시 다음 단계가 열립니다."}</small>
      </div>
      <p className="nav-label">랩 목록</p>
      {labs.map((lab, labIndex) => {
        const labSteps = steps.filter((item) => item.lab === labIndex + 1);
        const firstIndex = steps.findIndex((item) => item.lab === labIndex + 1);
        const accessible = firstIndex >= 0 && canAccess(firstIndex);
        const done = labSteps.length > 0 && labSteps.every((item) => resolvedIds.has(item.id));
        const hasSkip = done && labSteps.some((item) => skipped.includes(item.id));
        return <button
          className={`lab-item ${step.lab === labIndex + 1 ? "selected" : ""} ${!accessible ? "locked" : ""}`}
          onClick={() => goToStep(firstIndex)} aria-disabled={!accessible} key={lab.name}
        >
          <b>{labIndex + 1}</b><span><em>{lab.name}</em><small>{lab.time} · {labSteps.length}단계</small></span>
          {done ? hasSkip ? <FastForward className="lab-skipped" /> : <CheckCircle2 /> : !accessible ? <LockKeyhole /> : null}
        </button>;
      })}
      <div className="step-section">
        <p className="nav-label">단계</p>
        <div className="step-list">
          {steps.map((item, index) => {
            const accessible = canAccess(index);
            const isDone = completed.includes(item.id);
            const isSkipped = skipped.includes(item.id);
            return <button
              key={item.id}
              className={`step-item ${index === active ? "active" : ""} ${!accessible ? "locked" : ""} ${isSkipped ? "skipped" : ""}`}
              onClick={() => goToStep(index)}
              aria-disabled={!accessible}
              aria-current={index === active ? "step" : undefined}
              aria-label={`${item.title}${!accessible ? " — 잠김" : isSkipped ? " — 스킵" : isDone ? " — 완료" : ""}`}
            >
              <span className={`step-dot ${isDone ? "done" : isSkipped ? "skipped" : ""}`}>
                {isDone ? <Check /> : isSkipped ? <FastForward /> : !accessible ? <LockKeyhole /> : index + 1}
              </span>
              <span>{item.title}</span>
            </button>;
          })}
        </div>
      </div>
    </aside>

    <div className="mobile-switch">
      <button className={mobilePane === "guide" ? "active" : ""} onClick={() => setMobilePane("guide")}><PanelLeftClose />가이드</button>
      <button className={mobilePane === "terminal" ? "active" : ""} onClick={() => setMobilePane("terminal")}><TerminalSquare />터미널</button>
      <button onClick={() => setMobileStepsOpen(true)}><ListChecks />{active + 1}/{steps.length}</button>
    </div>

    <section className={`guide ${mobilePane !== "guide" ? "mobile-hidden" : ""}`}>
      <div className="guide-inner">
        <section className={`lab-overview ${overviewOpen ? "open" : ""}`}>
          <button className="lab-overview-toggle" onClick={() => setOverviewOpen(!overviewOpen)} aria-expanded={overviewOpen}>
            <span className="lab-number">LAB {step.lab}</span>
            <span><strong>{currentLab.name}</strong><small>{currentLab.time} · {currentLab.level}</small></span>
            <ChevronDown />
          </button>
          {overviewOpen && <div className="lab-overview-body">
            <p className="course-identity"><strong>{course.title}</strong> · {course.level} · {labs.length}개 랩 · {steps.length}단계 · 약 {course.durationMinutes}분</p>
            <p className="course-note">{isTerraform
              ? "학습자별 Linux 사용자와 systemd 제한으로 격리된 Docker-free Terraform 환경입니다. 외부 네트워크는 차단되며 실제 자격 증명이나 고객 데이터를 입력하면 안 됩니다."
              : "학습자별 Linux 사용자와 systemd 제한으로 격리된 교육용 Vault에서 진행합니다. 서버 검증용 관리 토큰은 터미널에 노출되지 않으며 실제 운영 비밀을 입력하면 안 됩니다."}</p>
            <p>{currentLab.description}</p>
            <div>{currentLab.outcomes.map((outcome) => <span key={outcome}><Check />{outcome}</span>)}</div>
          </div>}
        </section>

        <div className="step-heading">
          <p className="step-count">{active + 1}단계 / {steps.length}단계</p>
          <span className={completed.includes(step.id) ? "status-done" : skipped.includes(step.id) ? "status-skipped" : "status-current"}>
            {completed.includes(step.id) ? "완료" : skipped.includes(step.id) ? "스킵됨" : "진행 중"}
          </span>
        </div>
        <h1>{step.title}</h1>
        <p className="description">{step.description}</p>
        <div className="command-block">
          <span>실행할 명령</span>
          <div>
            <code>{step.command}</code>
            <span className="command-actions">
              <button className={copiedStep === step.id ? "copied" : ""} aria-label="명령 복사" onClick={copyCommand}>
                {copiedStep === step.id ? <Check /> : <Copy />}<span>{copiedStep === step.id ? "복사됨" : "복사"}</span>
              </button>
              <button aria-label="명령을 터미널에 입력" onClick={sendToTerminal}><Send /><span>터미널에 입력</span></button>
            </span>
          </div>
        </div>
        <div className="objective"><Target /><div><strong>학습 목표</strong><p>{step.objective}</p></div></div>
        <div className="concept"><BookOpen /><div><strong>핵심 개념</strong><p>{step.concept}</p></div></div>

        <button className={`hint-toggle ${hint ? "open" : ""}`} onClick={() => setHint(!hint)} aria-expanded={hint}><Lightbulb />힌트 보기<ChevronDown /></button>
        {hint && <div className="hint">{step.hint}</div>}
        <div className="expected"><span>예상 결과</span><code>{step.expected}</code></div>
        <button className={`trouble-toggle ${troubleshooting ? "open" : ""}`} onClick={() => setTroubleshooting(!troubleshooting)} aria-expanded={troubleshooting}><CircleAlert />문제가 생겼나요?<ChevronDown /></button>
        {troubleshooting && <ul className="trouble-list">{step.troubleshooting.map((item) => <li key={item}>{item}</li>)}</ul>}
        <div className="success"><h2>성공 기준</h2><p>{step.success}</p></div>

        <div className="validation-action">
          <button className="primary" disabled={checking} onClick={validate}>{checking ? <LoaderCircle className="spin" /> : <Play />}{completed.includes(step.id) ? "다시 검증" : "검증하기"}</button>
          {!completed.includes(step.id) && <button className="skip-button" disabled={checking} onClick={skipStep}><FastForward />스킵</button>}
          <span>{isAdmin
            ? "직접 이동은 진도를 변경하지 않으며, 검증·스킵에는 선행 단계 순서가 적용됩니다."
            : "성공 또는 스킵 후 다음 단계가 열립니다."}</span>
        </div>
        <nav className="step-navigation" aria-label="단계 이동">
          <button disabled={active === 0 || checking} onClick={() => goToStep(active - 1)}>이전 단계</button>
          <span>{active + 1} / {steps.length}</span>
          <button disabled={!canAccess(active + 1) || checking} onClick={() => goToStep(active + 1)}>다음 단계</button>
        </nav>
      </div>

      {feedback && <div className={`feedback ${feedback.type}`} role="status" aria-live="polite">
        {feedback.type === "success" ? <CheckCircle2 /> : feedback.type === "skipped" ? <FastForward /> : <CircleAlert />}
        <div>
          <strong>{feedback.type === "success" ? "검증 성공" : feedback.type === "skipped" ? "단계 스킵" : "다시 확인해 주세요"}</strong>
          <p>{feedback.message}</p>
          {feedback.checks?.length ? <ul className="validation-checks">
            {feedback.checks.map((check) => <li className={check.ok ? "ok" : "failed"} key={check.label}>
              {check.ok ? <CheckCircle2 /> : <CircleAlert />}
              <span><strong>{check.label}</strong>{check.detail && <small>{check.detail}</small>}</span>
            </li>)}
          </ul> : null}
        </div>
        {canAccess(active + 1) && <button onClick={() => goToStep(active + 1)}>다음 단계</button>}
        {currentResolved && isLastStep && <span className="course-complete"><Trophy />{skipped.length ? `과정 종료 · 스킵 ${skipped.length}` : "과정 완료"}</span>}
      </div>}
    </section>

    <section className={`terminal-pane ${mobilePane !== "terminal" ? "mobile-hidden" : ""}`}>
      <div className="terminal-title"><span><TerminalSquare />웹 터미널</span><button onClick={() => setReconnectKey((value) => value + 1)}><RotateCcw />터미널 재연결</button></div>
      <Terminal session={session} reconnectKey={reconnectKey} labName={labName} />
    </section>

    {toast && <div className={`toast ${toast.type}`} role="status">{toast.type === "success" ? <CheckCircle2 /> : <CircleAlert />}{toast.message}</div>}

    {catalogOpen && <div className="catalog-backdrop" role="presentation" onClick={() => setCatalogOpen(false)}>
      <section
        ref={catalogDialogRef}
        className="catalog-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-title"
        aria-describedby="catalog-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div><span><Library />교육 과정</span><h2 id="catalog-title">{subjectName} 학습 경로 카탈로그</h2><p id="catalog-description">네이티브 실행 과정과 외부 샌드박스 연동 과정을 명확히 구분했습니다.</p></div>
          <button aria-label="과정 카탈로그 닫기" onClick={() => setCatalogOpen(false)}><X /></button>
        </header>
        {catalogError ? <div className="catalog-empty"><CircleAlert /><p>{catalogError}</p><button onClick={() => { setCatalog(null); void openCatalog(); }}>다시 시도</button></div> :
          !catalog ? <div className="catalog-empty"><LoaderCircle className="spin" /><p>과정을 불러오는 중입니다…</p></div> :
            <div className="catalog-grid">{catalog.tracks.map((track) => <article className={`course-card ${track.readiness}`} key={track.id}>
              <div className="course-card-top">
                <span className="course-delivery">{track.delivery === "native" ? <TerminalSquare /> : <ServerCog />}{track.delivery === "native" ? "EC2 네이티브" : track.delivery === "dedicated" ? "전용 환경" : "외부 연동"}</span>
                <span className="course-readiness">{track.readiness === "active" ? "학습 중" : track.readiness === "ready" ? "활성화 가능" : "연동 필요"}</span>
              </div>
              <h3>{track.title}</h3>
              <p>{track.summary}</p>
              <div className="course-meta"><span>{track.level}</span><span>{track.durationMinutes}분</span></div>
              <ul>{track.outcomes.map((outcome) => <li key={outcome}><Check />{outcome}</li>)}</ul>
              {track.requirements.length > 0 && <details><summary>필요한 연동 {track.requirements.length}개</summary><p>{track.requirements.join(" · ")}</p></details>}
            </article>)}</div>}
      </section>
    </div>}

    {mobileStepsOpen && <div className="mobile-steps-backdrop" onClick={() => setMobileStepsOpen(false)}>
      <aside className="mobile-steps-drawer" onClick={(event) => event.stopPropagation()}>
        <header><div><strong>전체 단계</strong><span>완료 {completed.length} · 스킵 {skipped.length}</span></div><button aria-label="단계 목록 닫기" onClick={() => setMobileStepsOpen(false)}><X /></button></header>
        <div className="mobile-step-list">
          {steps.map((item, index) => {
            const accessible = canAccess(index);
            const isDone = completed.includes(item.id);
            const isSkipped = skipped.includes(item.id);
            return <button key={item.id} onClick={() => goToStep(index)} aria-disabled={!accessible} className={index === active ? "active" : ""}>
              <span>{isDone ? <Check /> : isSkipped ? <FastForward /> : !accessible ? <LockKeyhole /> : index + 1}</span>
              <div><small>LAB {item.lab}</small><strong>{item.title}</strong></div>
            </button>;
          })}
        </div>
      </aside>
    </div>}
  </div>;
}
