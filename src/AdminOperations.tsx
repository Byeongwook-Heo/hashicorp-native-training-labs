import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Ban,
  BookOpenCheck,
  Check,
  Clock3,
  Copy,
  FileCode2,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  TicketCheck,
  UserPlus,
  UsersRound
} from "lucide-react";
import { copyText } from "./copy-text";
import "./admin.css";

export type AdminOperationsProps = {
  role: "admin" | "instructor";
};

export type OperationsCohort = {
  id: string;
  name: string;
  courseId?: string;
  instructorIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type OperationsInvite = {
  id: string;
  role: "admin" | "instructor" | "learner";
  email?: string;
  cohortId?: string;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
};

export type OperationsCatalog = {
  version: number;
  updatedAt: string;
  tracks: Array<{
    id: string;
    title: string;
    summary: string;
    level: string;
    durationMinutes: number;
    delivery: "native" | "integration" | "dedicated";
    readiness: "active" | "ready" | "requires-integration";
    outcomes: string[];
    requirements: string[];
  }>;
};

type OperationsTab = "cohorts" | "invites" | "catalog";
type Toast = { type: "success" | "error"; message: string };

const roleLabels: Record<OperationsInvite["role"], string> = {
  admin: "관리자",
  instructor: "강사",
  learner: "교육생"
};

const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

const formatDate = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
};

const messageFromBody = (body: unknown, fallback: string) => {
  if (body && typeof body === "object") {
    if ("message" in body && typeof body.message === "string") return body.message;
    if ("error" in body && typeof body.error === "string") return body.error;
  }
  return fallback;
};

async function requestJson<T>(
  url: string,
  init: RequestInit,
  fallback: string
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new Error(messageFromBody(body, fallback));
  return body as T;
}

function PanelLoading({ message }: { message: string }) {
  return (
    <div className="vl-ops-state" role="status" aria-live="polite">
      <LoaderCircle className="vl-spin" aria-hidden="true" />
      <strong>{message}</strong>
      <span>서버에서 최신 정보를 확인하고 있습니다.</span>
    </div>
  );
}

function PanelError({
  message,
  onRetry
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="vl-ops-state vl-ops-state--error" role="alert">
      <AlertCircle aria-hidden="true" />
      <strong>정보를 불러오지 못했습니다</strong>
      <span>{message}</span>
      <button type="button" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        다시 시도
      </button>
    </div>
  );
}

export function AdminOperations({ role }: AdminOperationsProps) {
  const [activeTab, setActiveTab] = useState<OperationsTab>("cohorts");
  const [cohorts, setCohorts] = useState<OperationsCohort[]>([]);
  const [cohortsLoaded, setCohortsLoaded] = useState(false);
  const [cohortsLoading, setCohortsLoading] = useState(false);
  const [cohortsError, setCohortsError] = useState("");
  const [invites, setInvites] = useState<OperationsInvite[]>([]);
  const [invitesLoaded, setInvitesLoaded] = useState(false);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState("");
  const [catalog, setCatalog] = useState<OperationsCatalog | null>(null);
  const [catalogYaml, setCatalogYaml] = useState("");
  const [savedCatalogYaml, setSavedCatalogYaml] = useState("");
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [cohortName, setCohortName] = useState("");
  const [courseId, setCourseId] = useState("");
  const [inviteRole, setInviteRole] = useState<OperationsInvite["role"]>("learner");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCohortId, setInviteCohortId] = useState("");
  const [inviteHours, setInviteHours] = useState("72");
  const [inviteMaxUses, setInviteMaxUses] = useState("1");
  const [newInviteCode, setNewInviteCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const copyResetTimer = useRef<number | null>(null);

  const loadCohorts = useCallback(async (signal?: AbortSignal) => {
    setCohortsLoading(true);
    setCohortsError("");
    try {
      const body = await requestJson<{ cohorts?: OperationsCohort[] }>(
        "/api/auth/cohorts",
        { method: "GET", signal },
        "교육 그룹을 불러오지 못했습니다."
      );
      if (!Array.isArray(body.cohorts)) throw new Error("교육 그룹 응답 형식이 올바르지 않습니다.");
      setCohorts(body.cohorts);
      setCohortsLoaded(true);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setCohortsError(caught instanceof Error ? caught.message : "교육 그룹을 불러오지 못했습니다.");
    } finally {
      if (!signal?.aborted) setCohortsLoading(false);
    }
  }, []);

  const loadInvites = useCallback(async (signal?: AbortSignal) => {
    setInvitesLoading(true);
    setInvitesError("");
    try {
      const body = await requestJson<{ invites?: OperationsInvite[] }>(
        "/api/auth/invites",
        { method: "GET", signal },
        "초대 목록을 불러오지 못했습니다."
      );
      if (!Array.isArray(body.invites)) throw new Error("초대 목록 응답 형식이 올바르지 않습니다.");
      setInvites(body.invites);
      setInvitesLoaded(true);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setInvitesError(caught instanceof Error ? caught.message : "초대 목록을 불러오지 못했습니다.");
    } finally {
      if (!signal?.aborted) setInvitesLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const body = await requestJson<{ catalog?: OperationsCatalog; yaml?: string }>(
        "/api/content/admin/catalog",
        { method: "GET", signal },
        "과정 카탈로그를 불러오지 못했습니다."
      );
      if (!body.catalog || typeof body.yaml !== "string") {
        throw new Error("과정 카탈로그 응답 형식이 올바르지 않습니다.");
      }
      setCatalog(body.catalog);
      setCatalogYaml(body.yaml);
      setSavedCatalogYaml(body.yaml);
      setCatalogLoaded(true);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setCatalogError(caught instanceof Error ? caught.message : "과정 카탈로그를 불러오지 못했습니다.");
    } finally {
      if (!signal?.aborted) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (activeTab === "cohorts" && !cohortsLoaded) {
      void loadCohorts(controller.signal);
    }
    if (activeTab === "invites") {
      if (!invitesLoaded) void loadInvites(controller.signal);
      if (!cohortsLoaded) void loadCohorts(controller.signal);
    }
    if (activeTab === "catalog" && !catalogLoaded) {
      void loadCatalog(controller.signal);
    }
    return () => controller.abort();
  }, [
    activeTab,
    loadCatalog,
    loadCohorts,
    loadInvites
  ]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => () => {
    if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current);
  }, []);

  const createCohort = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = cohortName.trim();
    if (!name || pending) return;
    setPending("cohort-create");
    setCohortsError("");
    try {
      const body = await requestJson<{ cohort?: OperationsCohort }>(
        "/api/auth/cohorts",
        {
          method: "POST",
          body: JSON.stringify({ name, courseId: courseId.trim() || undefined })
        },
        "교육 그룹을 만들지 못했습니다."
      );
      if (!body.cohort) throw new Error("생성된 교육 그룹 정보를 받지 못했습니다.");
      setCohorts((current) => [...current, body.cohort!]);
      setCohortName("");
      setCourseId("");
      setCohortsLoaded(true);
      setToast({ type: "success", message: "교육 그룹을 만들었습니다." });
    } catch (caught) {
      setCohortsError(caught instanceof Error ? caught.message : "교육 그룹을 만들지 못했습니다.");
    } finally {
      setPending("");
    }
  };

  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const expiresInHours = Number(inviteHours);
    const maxUses = Number(inviteMaxUses);
    if (
      !Number.isInteger(expiresInHours) ||
      expiresInHours < 1 ||
      !Number.isInteger(maxUses) ||
      maxUses < 1
    ) {
      setInvitesError("유효 시간과 최대 사용 횟수는 1 이상의 정수여야 합니다.");
      return;
    }
    if (role === "instructor" && !inviteCohortId) {
      setInvitesError("강사가 만드는 교육생 초대에는 교육 그룹을 선택해야 합니다.");
      return;
    }

    setPending("invite-create");
    setInvitesError("");
    setCopied(false);
    try {
      const body = await requestJson<{ invite?: OperationsInvite; inviteCode?: string }>(
        "/api/auth/invites",
        {
          method: "POST",
          body: JSON.stringify({
            role: inviteRole,
            email: inviteEmail.trim() || undefined,
            cohortId: inviteCohortId || undefined,
            expiresInHours,
            maxUses
          })
        },
        "초대 코드를 만들지 못했습니다."
      );
      if (!body.invite || typeof body.inviteCode !== "string") {
        throw new Error("생성된 초대 코드 정보를 받지 못했습니다.");
      }
      setInvites((current) => [body.invite!, ...current]);
      setInvitesLoaded(true);
      setNewInviteCode(body.inviteCode);
      setInviteEmail("");
      setToast({ type: "success", message: "새 초대 코드를 만들었습니다." });
    } catch (caught) {
      setInvitesError(caught instanceof Error ? caught.message : "초대 코드를 만들지 못했습니다.");
    } finally {
      setPending("");
    }
  };

  const revokeInvite = async (invite: OperationsInvite) => {
    if (pending || invite.revokedAt) return;
    if (!window.confirm("이 초대 코드를 취소할까요? 취소 후에는 다시 사용할 수 없습니다.")) return;
    const pendingKey = `revoke:${invite.id}`;
    setPending(pendingKey);
    setInvitesError("");
    try {
      await requestJson<{ ok?: boolean }>(
        `/api/auth/invites/${encodeURIComponent(invite.id)}/revoke`,
        { method: "POST", body: JSON.stringify({}) },
        "초대 코드를 취소하지 못했습니다."
      );
      const revokedAt = new Date().toISOString();
      setInvites((current) =>
        current.map((candidate) =>
          candidate.id === invite.id ? { ...candidate, revokedAt } : candidate
        )
      );
      setToast({ type: "success", message: "초대 코드를 취소했습니다." });
    } catch (caught) {
      setInvitesError(caught instanceof Error ? caught.message : "초대 코드를 취소하지 못했습니다.");
    } finally {
      setPending("");
    }
  };

  const saveCatalog = async () => {
    if (role !== "admin" || pending || !catalogYaml.trim()) return;
    setPending("catalog-save");
    setCatalogError("");
    try {
      const body = await requestJson<{ catalog?: OperationsCatalog; yaml?: string }>(
        "/api/content/admin/catalog",
        { method: "PUT", body: JSON.stringify({ yaml: catalogYaml }) },
        "과정 카탈로그를 저장하지 못했습니다."
      );
      if (!body.catalog) throw new Error("저장된 카탈로그 정보를 받지 못했습니다.");
      const normalizedYaml = typeof body.yaml === "string" ? body.yaml : catalogYaml;
      setCatalog(body.catalog);
      setCatalogYaml(normalizedYaml);
      setSavedCatalogYaml(normalizedYaml);
      setToast({ type: "success", message: "과정 카탈로그를 저장했습니다." });
    } catch (caught) {
      setCatalogError(caught instanceof Error ? caught.message : "과정 카탈로그를 저장하지 못했습니다.");
    } finally {
      setPending("");
    }
  };

  const copyInvite = async () => {
    if (!newInviteCode) return;
    try {
      await copyText(newInviteCode);
      setCopied(true);
      setToast({ type: "success", message: "초대 코드를 클립보드에 복사했습니다." });
      if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setToast({ type: "error", message: "복사하지 못했습니다. 초대 코드를 직접 선택해 주세요." });
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (role === "admin" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveCatalog();
    }
  };

  const activeInvites = useMemo(
    () =>
      invites.filter(
        (invite) =>
          !invite.revokedAt &&
          new Date(invite.expiresAt).getTime() > Date.now() &&
          invite.uses < invite.maxUses
      ).length,
    [invites]
  );
  const catalogDirty = catalogYaml !== savedCatalogYaml;
  const catalogBytes = useMemo(() => new TextEncoder().encode(catalogYaml).length, [catalogYaml]);

  const tabs: Array<{
    id: OperationsTab;
    label: string;
    icon: typeof UsersRound;
  }> = [
    { id: "cohorts", label: "교육 그룹", icon: UsersRound },
    { id: "invites", label: "초대 관리", icon: TicketCheck },
    { id: "catalog", label: "과정 YAML", icon: FileCode2 }
  ];

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: OperationsTab
  ) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === currentTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex].id;
    setActiveTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`operations-tab-${nextTab}`)?.focus();
    });
  };

  return (
    <section className="vl-operations" aria-labelledby="operations-title">
      <header className="vl-ops-header">
        <div>
          <h2 id="operations-title">교육 운영 설정</h2>
          <p>교육 그룹과 초대를 관리하고, 제공할 실습 과정의 카탈로그를 확인합니다.</p>
        </div>
        <span className="vl-ops-role">
          <ShieldCheck aria-hidden="true" />
          {role === "admin" ? "관리자 권한" : "강사 권한"}
        </span>
      </header>

      <div className="vl-ops-tabs" role="tablist" aria-label="교육 운영 설정">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            id={`operations-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`operations-panel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            className={activeTab === id ? "is-active" : undefined}
            onClick={() => setActiveTab(id)}
            onKeyDown={(event) => handleTabKeyDown(event, id)}
          >
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "cohorts" && (
        <div
          id="operations-panel-cohorts"
          className="vl-ops-panel"
          role="tabpanel"
          aria-labelledby="operations-tab-cohorts"
        >
          {cohortsLoading && !cohortsLoaded ? (
            <PanelLoading message="교육 그룹을 불러오는 중입니다" />
          ) : cohortsError && !cohortsLoaded ? (
            <PanelError message={cohortsError} onRetry={() => void loadCohorts()} />
          ) : (
            <div className="vl-ops-split">
              <form className="vl-ops-form" onSubmit={createCohort}>
                <div className="vl-ops-form-heading">
                  <span><Plus aria-hidden="true" /></span>
                  <div>
                    <h3>새 교육 그룹</h3>
                    <p>같은 일정으로 학습할 교육생을 묶습니다.</p>
                  </div>
                </div>
                <label>
                  <span>그룹 이름</span>
                  <input
                    value={cohortName}
                    onChange={(event) => setCohortName(event.target.value)}
                    placeholder="예: 8월 플랫폼 엔지니어 과정"
                    maxLength={120}
                    disabled={Boolean(pending)}
                    required
                  />
                </label>
                <label>
                  <span>과정 ID <small>선택</small></span>
                  <input
                    value={courseId}
                    onChange={(event) => setCourseId(event.target.value)}
                    placeholder="미입력 시 기본 과정"
                    disabled={Boolean(pending)}
                  />
                </label>
                {cohortsError && <p className="vl-ops-form-error" role="alert">{cohortsError}</p>}
                <button className="vl-ops-primary" type="submit" disabled={!cohortName.trim() || Boolean(pending)}>
                  {pending === "cohort-create" ? (
                    <LoaderCircle className="vl-spin" aria-hidden="true" />
                  ) : (
                    <Plus aria-hidden="true" />
                  )}
                  교육 그룹 만들기
                </button>
              </form>

              <div className="vl-ops-list-section">
                <div className="vl-ops-list-heading">
                  <div>
                    <h3>관리 중인 교육 그룹</h3>
                    <p>{cohorts.length}개 그룹</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadCohorts()}
                    disabled={cohortsLoading}
                    aria-label="교육 그룹 새로고침"
                  >
                    <RefreshCw className={cohortsLoading ? "vl-spin" : undefined} aria-hidden="true" />
                  </button>
                </div>
                {!cohorts.length ? (
                  <div className="vl-ops-empty">
                    <UsersRound aria-hidden="true" />
                    <strong>아직 교육 그룹이 없습니다</strong>
                    <span>첫 그룹을 만들면 초대 코드를 그룹에 연결할 수 있습니다.</span>
                  </div>
                ) : (
                  <ul className="vl-ops-cohort-list">
                    {cohorts.map((cohort) => (
                      <li key={cohort.id}>
                        <span className="vl-ops-list-icon"><BookOpenCheck aria-hidden="true" /></span>
                        <div>
                          <strong>{cohort.name}</strong>
                          <span>{cohort.courseId || "기본 과정"}</span>
                          <small>
                            강사 {cohort.instructorIds.length}명 · {formatDate(cohort.createdAt)} 생성
                          </small>
                        </div>
                        <em className={cohort.archivedAt ? "is-archived" : undefined}>
                          {cohort.archivedAt ? "보관됨" : "운영 중"}
                        </em>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "invites" && (
        <div
          id="operations-panel-invites"
          className="vl-ops-panel"
          role="tabpanel"
          aria-labelledby="operations-tab-invites"
        >
          {invitesLoading && !invitesLoaded ? (
            <PanelLoading message="초대 목록을 불러오는 중입니다" />
          ) : invitesError && !invitesLoaded ? (
            <PanelError message={invitesError} onRetry={() => void loadInvites()} />
          ) : (
            <>
              {newInviteCode && (
                <div className="vl-invite-code" role="status" aria-live="polite">
                  <div>
                    <KeyRound aria-hidden="true" />
                    <span>
                      <strong>새 초대 코드</strong>
                      <small>보안을 위해 이 코드는 지금만 표시됩니다.</small>
                    </span>
                  </div>
                  <code>{newInviteCode}</code>
                  <button type="button" onClick={() => void copyInvite()} className={copied ? "is-copied" : undefined}>
                    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {copied ? "복사됨" : "코드 복사"}
                  </button>
                  <button
                    type="button"
                    className="vl-invite-code-close"
                    onClick={() => {
                      setNewInviteCode("");
                      setCopied(false);
                    }}
                  >
                    확인하고 닫기
                  </button>
                </div>
              )}

              <div className="vl-ops-split">
                <form className="vl-ops-form" onSubmit={createInvite}>
                  <div className="vl-ops-form-heading">
                    <span><UserPlus aria-hidden="true" /></span>
                    <div>
                      <h3>새 초대 코드</h3>
                      <p>대상과 사용 조건을 지정해 일회성 코드를 만듭니다.</p>
                    </div>
                  </div>
                  <label>
                    <span>초대 역할</span>
                    <select
                      value={inviteRole}
                      onChange={(event) => setInviteRole(event.target.value as OperationsInvite["role"])}
                      disabled={role === "instructor" || Boolean(pending)}
                    >
                      <option value="learner">교육생</option>
                      {role === "admin" && <option value="instructor">강사</option>}
                      {role === "admin" && <option value="admin">관리자</option>}
                    </select>
                  </label>
                  <label>
                    <span>이메일 <small>선택</small></span>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                      placeholder="특정 수신자에게 제한"
                      disabled={Boolean(pending)}
                    />
                  </label>
                  <label>
                    <span>교육 그룹 {role === "admin" && <small>선택</small>}</span>
                    <select
                      value={inviteCohortId}
                      onChange={(event) => setInviteCohortId(event.target.value)}
                      disabled={Boolean(pending)}
                      required={role === "instructor"}
                    >
                      <option value="">그룹을 선택해 주세요</option>
                      {cohorts
                        .filter((cohort) => !cohort.archivedAt)
                        .map((cohort) => (
                          <option key={cohort.id} value={cohort.id}>{cohort.name}</option>
                        ))}
                    </select>
                  </label>
                  <div className="vl-ops-form-row">
                    <label>
                      <span>유효 시간</span>
                      <input
                        type="number"
                        min="1"
                        max="720"
                        value={inviteHours}
                        onChange={(event) => setInviteHours(event.target.value)}
                        disabled={Boolean(pending)}
                      />
                      <small>시간</small>
                    </label>
                    <label>
                      <span>최대 사용</span>
                      <input
                        type="number"
                        min="1"
                        max="1000"
                        value={inviteMaxUses}
                        onChange={(event) => setInviteMaxUses(event.target.value)}
                        disabled={Boolean(pending)}
                      />
                      <small>회</small>
                    </label>
                  </div>
                  {invitesError && <p className="vl-ops-form-error" role="alert">{invitesError}</p>}
                  <button className="vl-ops-primary" type="submit" disabled={Boolean(pending)}>
                    {pending === "invite-create" ? (
                      <LoaderCircle className="vl-spin" aria-hidden="true" />
                    ) : (
                      <TicketCheck aria-hidden="true" />
                    )}
                    초대 코드 만들기
                  </button>
                </form>

                <div className="vl-ops-list-section">
                  <div className="vl-ops-list-heading">
                    <div>
                      <h3>발급한 초대</h3>
                      <p>사용 가능한 초대 {activeInvites}개</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadInvites()}
                      disabled={invitesLoading}
                      aria-label="초대 목록 새로고침"
                    >
                      <RefreshCw className={invitesLoading ? "vl-spin" : undefined} aria-hidden="true" />
                    </button>
                  </div>
                  {!invites.length ? (
                    <div className="vl-ops-empty">
                      <TicketCheck aria-hidden="true" />
                      <strong>아직 발급한 초대가 없습니다</strong>
                      <span>초대를 만들면 사용 여부와 만료 시간을 추적할 수 있습니다.</span>
                    </div>
                  ) : (
                    <ul className="vl-ops-invite-list">
                      {invites.map((invite) => {
                        const expired = new Date(invite.expiresAt).getTime() <= Date.now();
                        const exhausted = invite.uses >= invite.maxUses;
                        const inactive = Boolean(invite.revokedAt) || expired || exhausted;
                        const cohort = cohorts.find((candidate) => candidate.id === invite.cohortId);
                        return (
                          <li key={invite.id} className={inactive ? "is-inactive" : undefined}>
                            <div className="vl-ops-invite-main">
                              <span className={`vl-ops-invite-role vl-ops-invite-role--${invite.role}`}>
                                {roleLabels[invite.role]}
                              </span>
                              <strong>{invite.email || "이메일 제한 없음"}</strong>
                              <small>{cohort?.name || (invite.cohortId ? "알 수 없는 그룹" : "그룹 제한 없음")}</small>
                            </div>
                            <div className="vl-ops-invite-usage">
                              <span>{invite.uses}/{invite.maxUses}회 사용</span>
                              <small><Clock3 aria-hidden="true" /> {formatDate(invite.expiresAt)} 만료</small>
                            </div>
                            <div className="vl-ops-invite-action">
                              {invite.revokedAt ? (
                                <span><Ban aria-hidden="true" /> 취소됨</span>
                              ) : expired ? (
                                <span>만료됨</span>
                              ) : exhausted ? (
                                <span>사용 완료</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void revokeInvite(invite)}
                                  disabled={Boolean(pending)}
                                >
                                  {pending === `revoke:${invite.id}` ? (
                                    <LoaderCircle className="vl-spin" aria-hidden="true" />
                                  ) : (
                                    <Ban aria-hidden="true" />
                                  )}
                                  취소
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "catalog" && (
        <div
          id="operations-panel-catalog"
          className="vl-ops-panel"
          role="tabpanel"
          aria-labelledby="operations-tab-catalog"
        >
          {catalogLoading && !catalogLoaded ? (
            <PanelLoading message="과정 카탈로그를 불러오는 중입니다" />
          ) : catalogError && !catalogLoaded ? (
            <PanelError message={catalogError} onRetry={() => void loadCatalog()} />
          ) : (
            <div className="vl-catalog-editor">
              <div className="vl-catalog-toolbar">
                <div>
                  <h3>과정 카탈로그 YAML</h3>
                  <p>
                    버전 {catalog?.version ?? "—"} · {catalog?.tracks.length ?? 0}개 과정 · 최근 수정 {formatDate(catalog?.updatedAt)}
                  </p>
                </div>
                <div className="vl-catalog-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setCatalogYaml(savedCatalogYaml);
                      setCatalogError("");
                    }}
                    disabled={!catalogDirty || Boolean(pending) || role !== "admin"}
                  >
                    <RotateCcw aria-hidden="true" />
                    변경 취소
                  </button>
                  <button
                    type="button"
                    className="vl-ops-primary"
                    onClick={() => void saveCatalog()}
                    disabled={!catalogDirty || Boolean(pending) || role !== "admin"}
                  >
                    {pending === "catalog-save" ? (
                      <LoaderCircle className="vl-spin" aria-hidden="true" />
                    ) : (
                      <Save aria-hidden="true" />
                    )}
                    YAML 저장
                  </button>
                </div>
              </div>

              {role === "instructor" && (
                <div className="vl-catalog-notice">
                  <ShieldCheck aria-hidden="true" />
                  <span><strong>읽기 전용</strong> 과정 카탈로그 저장은 관리자만 할 수 있습니다.</span>
                </div>
              )}
              {catalogError && <p className="vl-ops-form-error" role="alert">{catalogError}</p>}

              <label className="vl-catalog-textarea">
                <span className="vl-sr-only">과정 카탈로그 YAML</span>
                <textarea
                  value={catalogYaml}
                  onChange={(event) => setCatalogYaml(event.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  readOnly={role !== "admin"}
                  spellCheck={false}
                  aria-describedby="catalog-editor-meta"
                />
              </label>
              <div className="vl-catalog-meta" id="catalog-editor-meta">
                <span>{catalogBytes.toLocaleString("ko-KR")} / 256,000 bytes</span>
                <span>
                  {role === "admin"
                    ? catalogDirty
                      ? "저장되지 않은 변경사항"
                      : "서버와 동기화됨"
                    : "관리자 권한이 필요합니다"}
                </span>
                {role === "admin" && <kbd>⌘/Ctrl + S</kbd>}
              </div>
            </div>
          )}
        </div>
      )}

      {toast && (
        <div className={`vl-admin-toast vl-admin-toast--${toast.type}`} role="status" aria-live="polite">
          {toast.type === "success" ? <Check aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
          {toast.message}
        </div>
      )}
    </section>
  );
}
