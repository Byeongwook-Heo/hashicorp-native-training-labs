# Terraform Native Lab 운영 가이드

Terraform Native Lab은 데스크톱 브라우저에서 설명·명령 복사·웹 터미널·서버 검증을 한 화면에 제공하는 8개 랩, 34단계 교육 환경입니다. 현재 단계를 검증에 통과하거나 명시적으로 스킵해야 다음 단계가 열립니다.

## 실행 경계

- Docker와 containerd를 설치하거나 사용하지 않습니다.
- 교육생마다 고정 Linux 사용자와 1GiB ext4 슬롯을 할당합니다.
- 슬롯은 `nodev,nosuid,noexec`로 마운트하고 세션 TTL이 끝나면 독립 reaper가 정리합니다.
- Terraform CLI는 1.15.8로 고정합니다.
- provider는 local 2.5.3, random 3.7.2, null 3.2.4, tls 4.1.0만 허용합니다.
- provider binary는 root 소유 offline mirror에서만 읽으며 세션 경로에는 symlink로 연결합니다.
- 실습 명령은 34개 검증·스킵 argv allowlist로 제한합니다.
- 교육생 프로세스는 외부 네트워크와 EC2 metadata에 접근할 수 없습니다.
- AWS provider, AWS 자격 증명, 원격 backend, remote module, provisioner는 이 과정에 포함하지 않습니다.
- HashiCorp Agent Skills는 commit `4451ceca5456e79cc776efee96a744f7ac96e5bf`로 고정한 root-owned read-only snapshot만 사용합니다.

## Terraform Agent Skills Lab

Agent Skill은 Terraform Provider, Terraform CLI plugin 또는 MCP server가 아닙니다. AI 코딩 에이전트가 특정 작업을 시작할 때 읽는 버전 관리된 지침 패키지이며 `SKILL.md`와 선택적인 references, scripts, assets로 구성됩니다. 고정한 Terraform bundle은 HCL style, test, import, Stacks, Policy, Module refactor, Azure와 Provider 생성·인증·리소스·Action·Ephemeral·Migration·문서·Acceptance Test를 다루는 active Skill 16개를 제공합니다. 각 기능과 사용 시점은 첫 단계의 `artifacts/skill-capabilities.json`에서 확인합니다.

이 과정은 설치 시 [HashiCorp 공식 Agent Skills 저장소](https://github.com/hashicorp/agent-skills)에서 검토된 commit을 정확히 fetch하고, Terraform·Packer product plugin 구조, 지원 문서와 MPL-2.0 라이선스를 `/opt/terraform-lab/agent-skills`에 보존합니다. 해당 16개 통합 구조와 에이전트 마켓플레이스는 snapshot 시점에 정식 tag가 아닌 upstream `main`의 `Unreleased` 상태이므로 commit을 고정합니다. commit, 필수 Skill 이름·lifecycle, symlink 부재, root 소유권, mode, 전체 SHA-256 manifest가 모두 맞아야 설치와 배포 smoke가 통과합니다.

학습자 슬롯에는 외부 네트워크가 없으므로 공식 온라인 설치 명령인 `npx skills add`나 에이전트 마켓플레이스 설치를 실행하지 않습니다. 대신 검증된 snapshot에서 선택한 `terraform-style-guide`, `terraform-test`, `refactor-module`을 `$HOME/terraform-lab/08-agent-skills/.agents/skills`에 복사합니다. 이 위치는 호환 에이전트가 발견할 수 있지만 Lab은 LLM/API를 호출하지 않습니다. 마지막 단계는 Skill-guided 산출물의 기준 계약을 offline fixture로 재현하고, 파일 구성, `terraform fmt -check`, `terraform validate`, saved plan JSON과 `terraform test`를 서버에서 다시 실행해 결과를 판정합니다.

Agent Skills는 AWS 권한이나 자격 증명을 제공하지 않지만, Skill을 읽는 에이전트는 안내된 명령 또는 포함 스크립트를 실행할 수 있습니다. 예를 들어 catalog의 `terraform-search-import`에는 필요 시 Terraform 초기화를 수행하는 helper가 포함됩니다. 이 Lab은 해당 Skill을 선택하거나 upstream script를 실행하지 않고, 모든 학습자 프로세스를 network-denied systemd scope에 유지합니다.

## 로컬 확인

```bash
npm ci
COURSE_ID=terraform-foundations \
MOCK_LAB=true \
AUTH_COOKIE_SECRET=mock-only-auth-cookie-secret-2026-change-me \
LAB_SESSION_SECRET=mock-only-lab-session-secret-2026-change-me \
npm run dev
```

로컬 mock 관리자:

- 이메일 `admin@terraform-lab.local`
- 비밀번호 `LocalAdminPassword!2026`

## 승인 AMI 배포

배포 스크립트는 AMI owner `888995627335`, Amazon Linux 2023, x86_64, EBS/HVM, available 상태와 다음 이름 중 하나를 모두 확인한 뒤에만 인스턴스를 생성합니다.

- `hc-security-base-*`
- `hc-base-*`

운영 배포에서는 검토한 `APPROVED_AMI_ID`를 반드시 고정합니다. 새 Terraform 후보는 기존 Vault 인스턴스를 수정하거나 종료하지 않습니다.

```bash
LAB_PROFILE=terraform \
AWS_REGION=ap-northeast-2 \
APPROVED_AMI_ID=ami-xxxxxxxxxxxxxxxxx \
SUBNET_ID=subnet-xxxxxxxxxxxxxxxxx \
SECURITY_GROUP_ID=sg-xxxxxxxxxxxxxxxxx \
ROUTE53_HOSTED_ZONE_ID=ZXXXXXXXXXXXXX \
LAB_HOST=terraform-lab.example.com \
LAB_ADMIN_EMAIL=admin@example.com \
ALLOCATE_EIP=false \
DEPLOY_BRANCH=Byeongwook-Heo/terraform-training-lab \
./infra/deploy.sh
```

Terraform profile의 기본 자원은 다음처럼 분리됩니다.

- Project tag `TerraformLab`
- IAM role/profile `terraform-lab-native-ec2-role` / `terraform-lab-native-ec2-profile`
- 임시 SSM bootstrap prefix `/terraform-lab/bootstrap`
- 애플리케이션 `/opt/terraform-lab`
- 데이터 `/var/lib/terraform-lab`
- 환경 파일 `/etc/terraform-lab/terraform-lab.env`
- 서비스 `terraform-lab-web.service`

EC2에는 22번 포트를 열지 않습니다. 운영 접속은 Session Manager를 사용하고, 웹 트래픽은 80/443만 허용합니다. 배포가 실패하면 이번 실행에서 만든 후보의 exact ID와 태그를 다시 확인한 뒤에만 정리합니다.

활성 Terraform 호스트에는 native installer를 다시 실행하지 않습니다. 코드, provider 또는 Agent Skills trust root를 갱신할 때도 새 승인 AMI 후보에서 34단계 정상 흐름과 짝수·홀수 교차 스킵→다음 명령 흐름을 실제 native runtime으로 통과시킨 뒤 DNS를 전환하는 blue/green 방식만 사용합니다.

Terraform 후보는 설치 직후 DNS를 전환하지 않습니다. 배포 도구가 후보를 먼저 재부팅하고 boot ID 변경, 슬롯별 `/run` 디렉터리 자동 복원, 최초 세션 생성, 웹 터미널 명령, 검증기와 로컬 smoke를 통과시킨 뒤에만 Route 53을 변경합니다. 슬롯 런타임 디렉터리는 `systemd-tmpfiles`가 `terraform-lab:tflab-sNN`, mode `2750`으로 재생성하며 제어 도구는 이 계약이 다르면 계속 fail-closed로 거부합니다.

## 최초 관리자

최초 설치가 성공하면 `/root/terraform-lab-initial-admin.txt`에 URL, 이메일, 임시 비밀번호가 root `0600`으로 생성됩니다. 정보를 암호 저장소로 옮긴 후 원격 파일을 삭제합니다. 서버 환경 파일에서는 bootstrap 직후 관리자 비밀번호 변수를 제거합니다.

## 배포 후 점검

```bash
sudo /opt/terraform-lab/current/infra/terraform-smoke-deployment.sh
```

점검은 과정 ID와 runtime kind, release commit, web UID·capability 경계, Terraform 버전, provider mirror checksum, HTTPS와 인증 전 WSS 동작을 확인합니다. 운영 인계 전에는 EC2 재부팅 후 health, 로그인, 터미널 연결, 검증→다음 단계 해제, 스킵→다음 단계 해제를 다시 확인합니다.

계정 수준에서 비승인 AMI 생성을 완전히 차단하려면 배포 스크립트와 별도로 EC2 Allowed AMIs 또는 Organizations 정책이 필요합니다.
