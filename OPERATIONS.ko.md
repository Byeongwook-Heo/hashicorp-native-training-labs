# 네이티브 교육 플랫폼 운영 가이드

AWS EC2에서 실행하는 한국어 HashiCorp Vault·Terraform 실습 플랫폼입니다. Instruqt처럼 설명, 웹 터미널, 서버 검증, 순차 잠금, 명시적 스킵, 강사 운영 기능을 한 화면에서 제공합니다.

이 프로젝트는 컨테이너 런타임을 사용하지 않습니다. 과정별 전용 EC2에서 각 교육생 환경을 Amazon Linux 2023의 별도 Linux 사용자와 on-demand systemd 서비스로 실행합니다.

## 학습 경험

- 7개 기본 랩, 30개 검증 단계, 약 140분
- Vault 상태·Auth Method·Secrets Engine
- KV v2 저장·회전·과거 버전·soft delete·복구
- Policy·capabilities·제한 Token·TTL
- AppRole 머신 인증
- Transit 암복호화·키 회전·rewrap
- Audit Device·권한 거부·토큰 폐기 장애 훈련
- PKI 내부 CA·제한된 Role·단기 인증서 발급
- 동작하는 복사 버튼과 “터미널에 입력” 버튼
- 현재 단계를 성공하거나 스킵해야 다음 단계 해제
- 검사 항목별 성공·실패 결과와 문제 해결 가이드

과정 카탈로그에는 SSH Certificate, Database 동적 자격 증명, AWS 동적 자격 증명, Kubernetes Auth, OIDC/JWT, Agent Auto-Auth, Raft, Terraform Provider 과정도 포함합니다. 외부 샌드박스가 필요한 과정은 UI에서 `연동 필요`로 구분합니다.

## Terraform 과정

별도 Terraform Lab은 8개 랩·34개 검증 단계·약 225분으로 구성됩니다. Terraform 1.15.8과 고정된 local, random, null, tls provider를 root 소유 offline mirror에서 사용하며 AWS 자격 증명을 교육생 환경에 제공하지 않습니다.

- init → saved plan → apply와 멱등성
- 타입 변수, tfvars, 표현식, 민감 출력
- state 조사, drift 탐지·복구, saved destroy plan
- for_each, count, 명시적 의존성과 graph
- module 계약, terraform test, moved refactor
- 민감 state 감사, validation·check, provider lock 무결성
- workspace, replace, refresh-only, 최종 exact JSON destroy gate
- HashiCorp Agent Skills 16개 catalog, project-local 설치, style·test 지침의 CLI 검증

HashiCorp Agent Skills는 Terraform Provider나 실행 plugin이 아니라 호환되는 AI 코딩 에이전트가 작업별로 읽는 `SKILL.md` 지침 패키지입니다. Lab은 [공식 저장소](https://github.com/hashicorp/agent-skills)의 검토된 commit `4451ceca5456e79cc776efee96a744f7ac96e5bf`을 설치 시 고정하고, 전체 product plugin 구조·지원 문서·MPL-2.0 라이선스를 root-owned read-only snapshot으로 보존합니다. 이 16개 통합 구조는 snapshot 시점에 정식 tag가 아닌 upstream `main`의 `Unreleased` 상태이므로 SHA를 명시적으로 고정합니다. 학습자 슬롯은 외부 네트워크가 계속 차단되므로 `npx`나 Git을 실행하지 않고 검증된 snapshot에서 선택한 Skill만 `.agents/skills`로 복사합니다.

Lab 화면과 `artifacts/skill-capabilities.json`은 구성·테스트·Import·Stacks·Policy·Module·Azure 및 Provider 개발 영역 16개의 기능과 사용 시점을 설명합니다. Project-local 경로는 호환 에이전트가 발견할 수 있지만 Lab 자체는 외부 LLM을 호출하지 않으며, 마지막 단계는 Skill-guided 산출물의 기준 계약을 offline fixture로 재현합니다. Skill 자체가 권한을 주지는 않아도 이를 읽는 에이전트가 안내된 명령이나 포함 스크립트를 실행할 수 있으므로 실제 사용에서는 검토와 sandbox가 필요합니다. 결과는 `terraform fmt -check`, `validate`, plan JSON, `terraform test`로 다시 검증합니다.

Terraform 운영·배포 계약은 [docs/terraform-lab.md](docs/terraform-lab.md)를 참고하세요. UI는 요청 범위에 맞춰 데스크톱 학습 환경을 기준으로 설계했습니다.

## 운영 기능

- scrypt 비밀번호와 서명된 `HttpOnly`, `Secure`, `SameSite=Strict` 쿠키
- 만료·사용 횟수가 제한된 초대 코드 가입
- admin, instructor, learner 역할
- 서버 저장 진행률과 감사 로그
- 강사 대시보드: 진행률, 스킵, 반복 실패, 세션 TTL
- 세션 초기화·연장·종료
- 과정·초대 관리와 검증형 YAML 카탈로그 편집
- 로그인·가입·일반 API·검증 요청 rate limit

## 네이티브 격리

- 세션마다 고정 Linux 사용자 슬롯과 독립 파일 영역
- Vault, 터미널, 검증기를 서로 다른 systemd scope로 실행
- CPU, 메모리, PID, 파일 디스크립터, syscall, writable path 제한
- 메타데이터 서비스와 외부 네트워크 차단, loopback만 허용
- 고정 dev token 대신 세션별 임의 초기화·unseal
- root token은 `/run`의 `0600` 파일과 one-shot systemd credential로만 사용
- 웹 터미널에는 커리큘럼 범위의 단기 `lab-student` 토큰만 제공
- 사용자당 활성 웹 터미널은 1개이며 새 연결이 기존 연결을 안전하게 교체
- 앱 janitor와 독립 systemd reaper가 TTL 만료 세션 정리

자세한 경계는 [infra/native/README.md](infra/native/README.md)를 참고하세요.

## 로컬 개발

로컬에서는 실제 명령을 실행하지 않는 mock 터미널과 mock 검증기를 사용합니다.

```bash
npm ci
MOCK_LAB=true \
AUTH_COOKIE_SECRET=mock-only-auth-cookie-secret-2026-change-me \
npm run dev
```

기본 mock 관리자:

- 이메일: `admin@vault-lab.local`
- 비밀번호: `LocalAdminPassword!2026`

Terraform 과정을 로컬 mock으로 확인하려면 `COURSE_ID=terraform-foundations`를 추가합니다. 이때 기본 관리자 이메일은 `admin@terraform-lab.local`입니다.

프로덕션에서는 이 기본값이 생성되지 않으며 32바이트 이상의 `AUTH_COOKIE_SECRET`이 필수입니다.

## 테스트

```bash
npm run build
npm test
npm audit --audit-level=moderate
```

## AWS EC2 생성

Vault와 Terraform은 서로 다른 EC2·도메인·IAM profile을 사용합니다. Terraform Lab은 다음처럼 `LAB_PROFILE=terraform`을 명시해 배포하며, 자세한 값은 [전용 운영 문서](docs/terraform-lab.md)에 정리되어 있습니다.

```bash
LAB_PROFILE=terraform \
APPROVED_AMI_ID=ami-xxxxxxxxxxxxxxxxx \
LAB_HOST=terraform-lab.example.com \
ALLOCATE_EIP=false \
./infra/deploy.sh
```

기존 운영 인스턴스에서 바로 교체하지 않고 새 EC2를 완전히 검증한 뒤 주소를 전환하는 blue/green 배포가 기본입니다. 로컬에 인증된 AWS CLI와 GitHub CLI가 필요합니다.

```bash
APPROVED_AMI_ID=ami-xxxxxxxxxxxxxxxxx ./infra/deploy.sh
```

기본 배포 계약은 다음과 같습니다.

- 리전 `ap-northeast-2`
- 승인된 `hc-security-base-*` 또는 `hc-base-*` 중 Amazon Linux 2023 x86_64 AMI만 사용
- 승인 AMI 소유자 `888995627335`를 변경 불가능하게 고정하고, 실제 AMI 이름·소유자·상태·아키텍처를 검증한 뒤에만 EC2 생성
- 운영 배포는 검토한 `APPROVED_AMI_ID`를 명시적으로 고정; 같은 client token과 EC2 원본 이미지 메타데이터로 생성 결과를 재검증
- `SUBNET_ID`를 명시적으로 지정
- Vault·Terraform 모두 과정별 전용 `SECURITY_GROUP_ID`를 명시적으로 지정
- `t3.medium`, 암호화된 30GiB gp3, IMDSv2 필수
- SSH 22번 포트 없음, 전용 IAM instance profile과 Session Manager만 사용
- Node.js 22, Vault 2.0.3, 동시 슬롯 4개
- 기본은 고정 Elastic IP, 할당량이 제한된 계정은 인스턴스 public IPv4와 운영 도메인의 HTTPS 주소

VPC나 계정이 다르면 환경 변수로 덮어쓸 수 있습니다.

```bash
AWS_REGION=ap-northeast-2 \
APPROVED_AMI_ID=ami-xxxxxxxxxxxxxxxxx \
SUBNET_ID=subnet-xxxxxxxx \
SECURITY_GROUP_ID=sg-xxxxxxxx \
INSTANCE_PROFILE_NAME=vault-lab-native-ec2-profile \
INSTANCE_ROLE_NAME=vault-lab-native-ec2-role \
DEPLOY_BRANCH=main \
./infra/deploy.sh
```

운영에서는 검토한 `APPROVED_AMI_ID`를 반드시 지정합니다. 테스트 목적의
명시적 `RESOLVE_LATEST_APPROVED_AMI=true`를 사용한 경우에만 승인 소유자의
`hc-security-base-al2023-x86_64-*`, `hc-base-al2023-x86_64-*` 중 최신
가용 이미지를 선택합니다. 명시한 ID도 동일한 이름 prefix와 AL2023
x86_64/EBS/HVM 계약을 통과해야 하며, AWS public AL2023 SSM parameter나
다른 이름의 AMI로 우회할 수 없습니다.

이 검증은 `infra/deploy.sh` 경로를 fail-closed로 만듭니다. 콘솔이나
직접 `RunInstances` 호출까지 계정 수준에서 차단하려면 영향 범위를 검토한
뒤 EC2 Allowed AMIs 또는 Organizations 정책을 별도로 활성화해야 합니다.
승인 소유자 계정의 AMI 게시 권한은 이 모델의 최종 신뢰 경계입니다.

운영 도메인까지 한 번에 전환하려면 public hosted zone과 host를 함께 지정합니다. 새 후보는 Caddy를 열지 않은 상태에서 native 설치와 local health를 먼저 통과합니다. 그 다음 단순 `A` 레코드를 후보 public IP로 바꾸고 Route 53 `INSYNC`를 확인한 뒤에만 Caddy 인증서 발급과 HTTPS/WSS smoke를 수행합니다. 전환과 rollback은 무조건 덮어쓰는 `UPSERT` 대신 현재 레코드의 exact `DELETE`와 다음 레코드의 `CREATE`를 한 change batch로 제출합니다. 조회 뒤 다른 운영자가 레코드를 바꿨다면 precondition이 실패하므로 그 변경을 덮어쓰지 않고 후보를 보존합니다. 가중치·지연·장애조치 라우팅 레코드는 안전을 위해 자동 전환하지 않습니다. EIP 할당량이 이미 찬 계정에서는 `ALLOCATE_EIP=false`를 지정할 수 있으며, 이 경우 인스턴스를 stop/start한 뒤 변경된 public IP로 DNS를 다시 갱신해야 합니다.

```bash
ROUTE53_HOSTED_ZONE_ID=Z000000000000EXAMPLE \
LAB_HOST=vault-lab.example.invalid \
LAB_ADMIN_EMAIL=admin@example.com \
APPROVED_AMI_ID=ami-xxxxxxxxxxxxxxxxx \
ALLOCATE_EIP=false \
DEPLOY_BRANCH=main \
./infra/deploy.sh
```

스크립트는 새 전용 ed25519 키를 GitHub repository에 read-only Deploy Key로 등록합니다. private key는 EC2 user-data나 SSM 명령문에 넣지 않고 임시 SSM `SecureString`으로 전달합니다. 전용 IAM role은 SSM agent 통신만 상시 허용하며 Parameter Store 전체 읽기 권한은 갖지 않습니다. 임시 정책은 정확한 SecureString과 새 후보 EC2의 `ec2:SourceInstanceARN`만 허용합니다. 인스턴스에서는 키를 root 소유 `0600`으로 저장하고, bootstrap이 끝나면 SecureString과 임시 IAM 권한을 삭제합니다. Git SSH는 GitHub가 공개한 ed25519 host key를 고정 검증하고 `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes`를 사용합니다.

`AUTO_INSTALL=true`가 기본이므로 cloud-init 완료를 SSM으로 확인한 뒤 private Git clone, 테스트, 빌드, native smoke, HTTPS/WSS smoke까지 자동 수행합니다. Terraform 후보는 34단계 정상 흐름과 교차 스킵→다음 단계 흐름까지 native runtime에서 통과해야 release가 활성화됩니다. 기본 설정에서는 Elastic IP를 새 후보에만 연결하며, `ALLOCATE_EIP=false`이면 EC2 public IPv4를 사용합니다. 운영 도메인을 지정한 경우 검증된 후보로 Route 53을 전환한 뒤 Caddy를 시작하며, cutover smoke가 실패하면 이전 A/Alias 레코드로 자동 복구합니다.

실패 후보는 기본 `KEEP_FAILED_CANDIDATE=false`입니다. 스크립트가 이번 실행에서 받은 EC2 instance ID와 EIP allocation ID, 고유 Deploy Key ID를 태그와 함께 다시 검증하고, Route 53 변경을 시도했다면 이전 레코드 복구가 `INSYNC`가 된 뒤에만 해당 신규 자원을 종료·해제·삭제합니다. DNS 변경 결과가 모호하거나 rollback이 실패하면 기존 트래픽을 더 손상시키지 않도록 후보를 그대로 보존합니다. 장애 조사를 위해 실패 후보를 항상 남기려면 `KEEP_FAILED_CANDIDATE=true`를 지정합니다. 기존 운영 EC2는 이 자동 정리 범위에 포함되지 않으며, 새 후보를 완전히 검증한 뒤 별도로 중지합니다.

## Git release 배포

서버 디렉터리는 역할별로 분리됩니다.

```bash
/opt/vault-lab/repository   # root 전용 read-only Git checkout
/opt/vault-lab/releases     # commit SHA별 검증된 release
/opt/vault-lab/current      # 활성 release를 가리키는 symlink
```

Vault 배포 업데이트:

```bash
sudo DEPLOY_BRANCH=main \
  /opt/vault-lab/current/infra/update-from-git.sh

# 승인된 commit을 정확히 지정할 수도 있습니다.
sudo DEPLOY_BRANCH=main \
  DEPLOY_COMMIT=0123456789abcdef0123456789abcdef01234567 \
  /opt/vault-lab/current/infra/update-from-git.sh
```

배포는 `flock`으로 직렬화됩니다. 새 commit을 별도 worktree에 만들고 빌드 전용 사용자로 `npm ci` → `npm test` → `npm run build` → production prune를 수행합니다. Caddy와 systemd 구성을 검증한 후 `current` symlink를 원자 전환하고, local health와 실제 도메인 SNI·Host를 유지한 HTTPS/WSS smoke가 실패하면 이전 release·환경·서비스 구성으로 자동 복구합니다. 이 smoke는 EC2의 EIP hairpin에 의존하지 않도록 로컬 Caddy 443으로 연결하므로, 배포 완료 후에는 별도의 외부 브라우저에서도 최종 접근을 확인합니다. Caddy는 admin API를 사용하지 않으므로 validate 후 항상 `systemctl restart caddy`로 적용합니다.

각 release의 native 제어 ABI와 설치된 `/etc/vault-lab/native-control-abi`도 함께 확인합니다. ABI가 같아도 helper·template이 달라지면 web 요청과 정확한 `vault-lab@sNN` unit을 먼저 종료해 이전 보안 경계의 세션이 새 web에 재사용되지 않게 한 뒤, native artifact 10개를 원자 동기화합니다. 따라서 native artifact가 바뀐 release에서는 활성 lab 세션이 새로 만들어집니다. 교체 전에는 web·reaper·loopback의 boot 시작을 잠시 끄고 durable `updating-<ABI>` marker와 root `0600` `/etc/vault-lab/native-smoke-pending` gate를 기록하므로 전원 중단 뒤에도 mixed 또는 smoke 미검증 runtime이 자동 기동하지 않습니다. pending gate는 재부팅·재시도 후에도 native smoke를 강제하며, smoke가 성공하고 새 `current` symlink가 durable하게 전환된 뒤에만 제거됩니다. web systemd unit도 파일 존재와 dangling symlink를 모두 `ExecStartPre`에서 거부합니다. 실패 시에는 root 소유권·mode까지 포함한 exact backup을 복구한 뒤에만 이전 web을 재시작합니다. ABI가 달라 UID·bounded storage·sysctl·slot unit migration이 필요하면 `native-install.sh`를 idempotent 재실행합니다. 이 migration이 시작된 뒤 후속 smoke가 실패하면 호환되지 않는 이전 web을 자동 재시작하지 않고 fail-closed로 두며, `/var/lib/vault-lab/deploy-backup.*`을 보존해 운영자가 원인을 확인할 수 있게 합니다.

완료된 release는 기본 5개를 유지합니다. 빌드가 중단된 worktree는 다음 재시도에서 정확한 `<40자리 SHA>.failed.<UTC 시각>.<PID>` 형식으로 격리하고, 새 빌드 전과 성공한 배포 후에 최신 2개만 남깁니다. 조사본 수는 `FAILED_RELEASE_RETENTION=0..20`으로 조정할 수 있으며, symlink·다른 경로·활성 release는 삭제 대상에서 제외됩니다.

Terraform Lab은 provider trust root와 슬롯 파일시스템을 함께 교체하므로 활성 호스트의 in-place 재설치를 허용하지 않습니다. 업데이트도 새 승인 AMI 후보에 `LAB_PROFILE=terraform` blue/green 배포를 다시 수행합니다.

같은 호스트에서 기존 프록시와 포트 전환을 분리해야 할 때는 최초 설치에 `DEFER_CADDY_START=true`를 사용합니다. 기존 listener가 80/443을 놓은 뒤 다음 명령이 Caddy validate, restart, 외부 smoke, 실패 시 rollback을 수행합니다.

```bash
sudo /opt/vault-lab/current/infra/cutover-caddy.sh
```

과정 YAML은 `/var/lib/vault-lab/content`에 분리되어 Git 업데이트가 강사 편집 내용을 덮어쓰지 않습니다. 최초 관리자 정보는 EC2의 `/root/vault-lab-initial-admin.txt`에 `0600`으로 저장되며, 첫 로그인 후 안전한 암호 저장소로 옮기고 파일을 삭제해야 합니다.

## 주요 환경 변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `AUTH_COOKIE_SECRET` | 로그인 쿠키 서명 키, 32바이트 이상 | 필수 |
| `LAB_SESSION_SECRET` | 사용자 ID를 내부 세션 ID로 변환하는 HMAC 키 | cookie secret |
| `LAB_STORE_PATH` | 사용자·진행·감사 JSON 저장소 | `data/vault-lab.json` |
| `CATALOG_PATH` | 편집 가능한 과정 YAML | `content/course-catalog.yaml` |
| `MAX_SESSIONS` | 동시에 활성화할 Linux 사용자 슬롯 | `4` |
| `SESSION_TTL_HOURS` | 세션 수명 | `4` |
| `LAB_ADMIN_EMAIL` | 최초 관리자 이메일 | 최초 실행 시 선택 |
| `LAB_ADMIN_PASSWORD` | 최초 관리자 비밀번호 | 최초 실행 시 선택 |

## 주의

이 환경은 교육 전용입니다. 실제 운영 비밀, 고객 데이터, 장기 AWS 자격 증명을 입력하지 마세요. AWS·Kubernetes·Database 연동 과정은 별도 샌드박스와 최소 권한 역할, 비용 정리 정책을 준비한 뒤 활성화해야 합니다.

설치 기준은 [HashiCorp의 Amazon Linux 패키지 안내](https://developer.hashicorp.com/vault/install), [Caddy의 공식 RHEL 계열 패키지 안내](https://caddyserver.com/docs/install), [GitHub read-only Deploy Key 안내](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)를 따릅니다.
