import { FormEvent, useState } from "react";
import {
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  TerminalSquare,
  UserRound
} from "lucide-react";
import "./admin.css";
import type { CourseDefinition } from "./types";

export type AuthUser = {
  id: string;
  displayName: string;
  email: string;
  role: "learner" | "instructor" | "admin";
  cohortIds: string[];
};

export type LoginProps = {
  onAuthenticated?: (user: AuthUser) => void;
  nextPath?: string;
  course?: CourseDefinition;
  courseTitle?: string;
  courseDescription?: string;
};

const readError = async (response: Response, fallback: string) => {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      return body.error;
    }
  } catch {
    // A concise fallback is clearer than exposing an unreadable server response.
  }
  return fallback;
};

export function Login({
  onAuthenticated,
  nextPath = "/",
  course,
  courseTitle = "HashiCorp Vault 실무 교육",
  courseDescription = "비밀 관리와 정책, AppRole, Transit부터 감사·장애 대응과 PKI 인증서 자동화까지 실제 환경에서 익히는 실습 과정입니다."
}: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"login" | "enroll">("login");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const isTerraform = course?.runtimeKind === "terraform-native";
  const labName = isTerraform ? "Terraform Lab" : "Vault Lab";
  const brandMark = isTerraform ? "T" : "V";
  const title = course?.title || courseTitle;
  const description = course?.summary || courseDescription;
  const labCount = course?.labCount || 7;
  const stepCount = course?.stepCount || 30;
  const duration = course?.durationMinutes || 140;
  const range = isTerraform ? "CLI부터 State·Module·운영까지" : "기초부터 운영·PKI까지";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
      setError("이메일과 비밀번호를 모두 입력해 주세요.");
      return;
    }
    if (mode === "enroll" && (!displayName.trim() || !inviteCode.trim())) {
      setError("이름과 초대 코드를 모두 입력해 주세요.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/enroll", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "login" ? {
          email: normalizedEmail,
          password
        } : {
          inviteCode: inviteCode.trim(),
          email: normalizedEmail,
          displayName: displayName.trim(),
          password
        })
      });

      if (!response.ok) {
        throw new Error(await readError(response, "로그인하지 못했습니다. 입력 정보를 확인해 주세요."));
      }

      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("user" in body) ||
        !body.user ||
        typeof body.user !== "object"
      ) {
        throw new Error("로그인은 완료됐지만 사용자 정보를 확인하지 못했습니다.");
      }

      const user = body.user as AuthUser;
      if (onAuthenticated) onAuthenticated(user);
      else window.location.assign(nextPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "로그인 중 알 수 없는 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="vl-login-shell">
      <section className="vl-login-story" aria-labelledby="course-title">
        <div className="vl-brand vl-brand--light">
          <span className="vl-brand-mark" aria-hidden="true">{brandMark}</span>
          <span>{labName}</span>
        </div>

        <div className="vl-login-story__content">
          <h1 id="course-title">{title}</h1>
          <p>{description}</p>

          <div className="vl-course-facts" aria-label="과정 안내">
            <div>
              <BookOpenCheck aria-hidden="true" />
              <span><strong>{labCount}개 랩 · {stepCount}단계</strong>{range}</span>
            </div>
            <div>
              <TerminalSquare aria-hidden="true" />
              <span><strong>직접 실행하는 실습</strong>각 단계 결과 자동 검증</span>
            </div>
            <div>
              <Clock3 aria-hidden="true" />
              <span><strong>약 {duration}분</strong>중단 후 이어서 학습 가능</span>
            </div>
          </div>
        </div>

        <p className="vl-login-story__note">
          <ShieldCheck aria-hidden="true" />
          교육생별로 분리된 환경에서 안전하게 실습합니다.
        </p>
      </section>

      <section className="vl-login-panel" aria-labelledby="login-title">
        <div className="vl-login-card">
          <div className="vl-login-mobile-brand">
            <span className="vl-brand-mark" aria-hidden="true">{brandMark}</span>
            <span>{labName}</span>
          </div>
          <div className="vl-login-icon" aria-hidden="true">
            <LockKeyhole />
          </div>
          <h2 id="login-title">교육랩 로그인</h2>
          <p className="vl-login-intro">초대받은 계정으로 로그인하면 나의 실습 환경과 진행 상태가 열립니다.</p>

          <div className="vl-login-mode" role="tablist" aria-label="인증 방식">
            <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setError(""); }}>로그인</button>
            <button type="button" role="tab" aria-selected={mode === "enroll"} className={mode === "enroll" ? "is-active" : ""} onClick={() => { setMode("enroll"); setError(""); }}>초대 코드로 가입</button>
          </div>

          <form onSubmit={submit} noValidate>
            {mode === "enroll" && <div className="vl-field">
              <label htmlFor="vault-enroll-name">이름</label>
              <span className="vl-input-wrap">
                <UserRound aria-hidden="true" />
                <input
                  id="vault-enroll-name"
                  type="text"
                  name="displayName"
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="교육생 이름"
                  disabled={submitting}
                  required
                />
              </span>
            </div>}

            <div className="vl-field">
              <label htmlFor="vault-login-email">교육 이메일</label>
              <span className="vl-input-wrap">
                <Mail aria-hidden="true" />
                <input
                  id="vault-login-email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.com"
                  aria-describedby={error ? "login-error" : undefined}
                  disabled={submitting}
                  required
                />
              </span>
            </div>

            <div className="vl-field">
              <label htmlFor="vault-login-password">비밀번호</label>
              <span className="vl-input-wrap">
                <KeyRound aria-hidden="true" />
                <input
                  id="vault-login-password"
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="비밀번호 입력"
                  aria-describedby={error ? "login-error" : undefined}
                  disabled={submitting}
                  required
                />
                <button
                  type="button"
                  className="vl-password-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                  aria-pressed={showPassword}
                  disabled={submitting}
                >
                  {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
              </span>
            </div>

            {mode === "enroll" && <div className="vl-field">
              <label htmlFor="vault-login-cohort">교육 초대 코드<small>강사가 발급한 일회성 코드</small></label>
              <span className="vl-input-wrap">
                <CheckCircle2 aria-hidden="true" />
                <input
                  id="vault-login-cohort"
                  type="text"
                  name="inviteCode"
                  autoComplete="one-time-code"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  placeholder="예: A1B2-C3D4-E5F6"
                  disabled={submitting}
                  required
                />
              </span>
            </div>}

            <div
              id="login-error"
              className={`vl-form-message${error ? " is-visible" : ""}`}
              role="alert"
              aria-live="assertive"
            >
              {error}
            </div>

            <button className="vl-login-submit" type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <LoaderCircle className="vl-spin" aria-hidden="true" />
                  로그인 확인 중
                </>
              ) : (
                <>
                  {mode === "login" ? "실습 시작하기" : "계정 만들고 시작하기"}
                  <ArrowRight aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          <p className="vl-login-help">
            {mode === "login" ? "처음 참여한다면 “초대 코드로 가입”을 선택하세요." : "초대 코드는 사용 횟수와 만료 시간이 제한됩니다."}
          </p>
        </div>
      </section>
    </main>
  );
}
