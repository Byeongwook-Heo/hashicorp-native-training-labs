import { steps as vaultSteps } from "./curriculum.js";
import {
  type CourseDefinition,
  type CourseRuntimeFactory,
  type CourseRuntimeFactoryOptions,
  type LabRuntime
} from "./course-definition.js";
import { MockVaultRuntime } from "./mock-runtime.js";
import { NativeVaultRuntime } from "./native-runtime.js";
import { terraformSteps } from "./terraform-curriculum.js";
import { NativeTerraformRuntime } from "./terraform-runtime.js";

export const DEFAULT_COURSE_ID = "vault-foundations";
export const TERRAFORM_COURSE_ID = "terraform-foundations";

const vaultCourse: CourseDefinition = {
  id: DEFAULT_COURSE_ID,
  title: "HashiCorp Vault 실무 기초",
  summary: "Vault의 핵심 개념부터 KV v2, Policy, AppRole, Transit, 운영 감사와 PKI까지 네이티브 환경에서 실습합니다.",
  level: "초급–중급",
  durationMinutes: 140,
  runtimeKind: "vault-native",
  labs: [
    {
      id: 1,
      name: "Vault 핵심 개념",
      time: "10분",
      level: "입문",
      description: "Vault의 상태와 구성 요소를 직접 조사하며 Auth Method와 Secrets Engine의 역할을 구분하는 오리엔테이션 랩입니다.",
      outcomes: ["initialized·sealed 상태 해석", "인증 방식과 비밀 엔진 구분"]
    },
    {
      id: 2,
      name: "KV 버전 관리",
      time: "20분",
      level: "입문",
      description: "애플리케이션 비밀의 전체 수명주기를 다룹니다. 저장과 회전부터 과거 버전 감사, soft delete와 복구까지 실습합니다.",
      outcomes: ["KV v2 경로와 버전 이해", "비밀 회전·삭제·복구 수행"]
    },
    {
      id: 3,
      name: "Policy와 Token",
      time: "20분",
      level: "중급",
      description: "최소 권한 원칙을 Vault ACL에 적용하고, 제한된 서비스 토큰의 실제 capability와 TTL을 검증하는 접근 제어 랩입니다.",
      outcomes: ["KV v2 ACL 정책 작성", "제한 토큰 권한과 수명 감사"]
    },
    {
      id: 4,
      name: "AppRole 인증",
      time: "20분",
      level: "중급",
      description: "비대화형 워크로드가 RoleID와 SecretID로 인증하고 단기 Vault 토큰을 얻는 머신 인증 흐름을 완성합니다.",
      outcomes: ["AppRole 역할과 제약 구성", "머신 로그인 토큰 발급"]
    },
    {
      id: 5,
      name: "Transit 암호화",
      time: "20분",
      level: "중급",
      description: "Vault를 애플리케이션 암호화 서비스로 사용합니다. 평문을 저장하지 않고 암복호화하며 키 회전과 rewrap까지 수행합니다.",
      outcomes: ["Transit 암복호화 구현", "무중단 키 회전과 rewrap"]
    },
    {
      id: 6,
      name: "운영·감사·장애 대응",
      time: "25분",
      level: "중급",
      description: "Audit Device를 실제 요청과 연결하고, 권한 거부와 토큰 폐기 사고를 재현해 정상적인 보안 통제와 장애를 구분합니다.",
      outcomes: ["감사 이벤트 추적", "권한 거부·토큰 폐기 진단"]
    },
    {
      id: 7,
      name: "PKI 인증서 자동화",
      time: "25분",
      level: "중급",
      description: "내부 CA와 제한된 발급 역할을 구성하고, 서비스 이름에 맞는 짧은 수명의 인증서를 동적으로 발급합니다.",
      outcomes: ["내부 CA와 발급 역할 구성", "단기 서비스 인증서 발급"]
    }
  ],
  steps: vaultSteps,
  copy: {
    serviceName: "Vault Lab",
    subjectName: "Vault",
    validationFailure: "서버가 현재 Vault 상태를 확인했지만 일부 성공 조건이 충족되지 않았습니다. 실패 항목과 힌트를 확인하세요.",
    mockTerminalBanner: "Vault Native Lab (mock)",
    terminalPrompt: "vault-lab $ ",
    mockAdminEmail: "admin@vault-lab.local"
  }
};

const terraformCourse: CourseDefinition = {
  id: TERRAFORM_COURSE_ID,
  title: "HashiCorp Terraform 실무 기초",
  summary: "HCL과 실행 계획부터 state·drift·module·test·Agent Skills·공급망 무결성·안전한 운영 워크플로까지, 실제 Terraform CLI로 단계별 실습합니다.",
  level: "초급–중급",
  durationMinutes: 225,
  runtimeKind: "terraform-native",
  labs: [
    {
      id: 1,
      name: "Terraform 실행 흐름",
      time: "25분",
      level: "입문",
      description: "고정된 CLI와 provider로 init, saved plan, apply, 멱등성의 기본 실행 계약을 익힙니다.",
      outcomes: ["init·plan·apply 흐름 이해", "saved plan과 멱등성 검증"]
    },
    {
      id: 2,
      name: "변수·표현식·민감 값",
      time: "30분",
      level: "입문",
      description: "타입이 있는 입력과 tfvars, 표현식, 민감 출력을 안전하게 다루는 구성 패턴을 실습합니다.",
      outcomes: ["변수 계약과 표현식 작성", "민감 값 노출 방지"]
    },
    {
      id: 3,
      name: "State·Drift·정리",
      time: "25분",
      level: "중급",
      description: "State 주소를 감사하고 out-of-band drift를 탐지·복구한 뒤 saved destroy plan으로 정리합니다.",
      outcomes: ["State와 실제 객체 구분", "Drift 복구와 안전한 destroy"]
    },
    {
      id: 4,
      name: "for_each·count·의존 그래프",
      time: "25분",
      level: "중급",
      description: "반복 리소스 주소와 명시적 의존성을 구성하고 그래프 artifact로 관계를 확인합니다.",
      outcomes: ["안정적인 반복 리소스 설계", "의존 그래프 분석"]
    },
    {
      id: 5,
      name: "Module·Test·Refactor",
      time: "35분",
      level: "중급",
      description: "로컬 module 계약, terraform test, moved block을 사용해 검증 가능한 무중단 refactor를 완성합니다.",
      outcomes: ["Module 입출력 계약 작성", "Test와 moved refactor 수행"]
    },
    {
      id: 6,
      name: "비밀·조건·공급망",
      time: "25분",
      level: "중급",
      description: "민감 state 위험, validation과 check block, provider lock checksum을 실제 동작으로 검증합니다.",
      outcomes: ["민감 state 감사", "조건과 provider 무결성 검증"]
    },
    {
      id: 7,
      name: "운영 워크플로",
      time: "25분",
      level: "중급",
      description: "Workspace 격리, replace, refresh-only, 최종 destroy를 exact JSON gate와 saved plan으로 수행합니다.",
      outcomes: ["운영 변경의 exact gate 적용", "안전한 refresh·replace·destroy"]
    },
    {
      id: 8,
      name: "Terraform Agent Skills",
      time: "35분",
      level: "중급",
      description: "AI 코딩 에이전트가 읽는 HashiCorp Agent Skills를 Provider·MCP와 구분하고, 16개의 기능을 비교해 고정 스냅샷에서 필요한 지침을 project-local로 설치한 뒤 offline 기준 산출물을 Terraform CLI로 검증합니다.",
      outcomes: ["Agent Skill 구조·출처·16개 기능·설치 범위 이해", "Style Guide와 Terraform Test 지침의 기계적 검증"]
    }
  ],
  steps: terraformSteps,
  copy: {
    serviceName: "Terraform Lab",
    subjectName: "Terraform",
    validationFailure: "서버가 현재 Terraform 구성과 state를 확인했지만 일부 성공 조건이 충족되지 않았습니다. 실패 항목과 힌트를 확인하세요.",
    mockTerminalBanner: "Terraform Native Lab (mock)",
    terminalPrompt: "terraform-lab $ ",
    mockAdminEmail: "admin@terraform-lab.local"
  }
};

const courses = new Map<string, CourseDefinition>([
  [vaultCourse.id, vaultCourse],
  [terraformCourse.id, terraformCourse]
]);

const runtimeFactories: Record<
  CourseDefinition["runtimeKind"],
  CourseRuntimeFactory
> = {
  "vault-native": ({ mock, maxSessions }) => mock
    ? new MockVaultRuntime()
    : new NativeVaultRuntime({ maxSessions }),
  "terraform-native": ({ mock, maxSessions }) => mock
    ? new MockVaultRuntime()
    : new NativeTerraformRuntime({ maxSessions })
};

export function resolveCourseDefinition(
  requestedId: string | undefined = process.env.COURSE_ID
): CourseDefinition {
  const courseId = requestedId === undefined ? DEFAULT_COURSE_ID : requestedId;
  const course = courses.get(courseId);
  if (!course) {
    throw new Error(`지원하지 않는 COURSE_ID입니다: ${courseId || "(empty)"}`);
  }
  return course;
}

export function createCourseRuntime(
  course: CourseDefinition,
  options: CourseRuntimeFactoryOptions
): LabRuntime {
  const factory = runtimeFactories[course.runtimeKind];
  if (!factory) {
    throw new Error(`등록되지 않은 과정 런타임입니다: ${course.runtimeKind}`);
  }
  return factory(options);
}
