# HashiCorp Native Training Labs

[한국어](README.md) · [English](README.en.md)

## 목적

브라우저에서 설명을 읽고 명령을 실행한 뒤 서버 검증으로 결과를 확인하는 한국어 Vault·Terraform 교육 플랫폼입니다. 강사는 학습 진행률과 실습 세션을 관리할 수 있습니다.

## 기대 효과

- 가이드·웹 터미널·검증 결과를 한 화면에서 확인해 실습 흐름을 이어갑니다.
- 단계별 성공·실패·스킵과 진행률을 기록해 학습 상태를 파악합니다.
- 실제 Linux 사용자와 systemd 기반 격리 환경에서 운영 명령을 연습합니다.

## 주요 기능과 구성

- React/Vite 프런트엔드, Express/WebSocket 서버, YAML 커리큘럼
- Vault: 7개 기본 랩·30개 검증 단계; KV, 정책, AppRole, Transit, Audit, PKI
- Terraform: 8개 랩·34개 검증 단계; plan/apply, state, module, test, workspace
- Terraform 과정은 고정 버전 CLI와 오프라인 provider mirror 사용
- 학습자·강사·관리자 역할, 초대 코드, 세션 TTL, 진행률과 감사 기록
- 네이티브 실습은 전용 EC2에서 실행하며 컨테이너 런타임을 사용하지 않음

## 시작하기

Node.js와 npm 버전은 `package.json`을 확인하세요. 먼저 실제 명령을 실행하지 않는 로컬 Mock 모드로 화면과 학습 흐름을 확인합니다.

```bash
npm ci
MOCK_LAB=true \
AUTH_COOKIE_SECRET=mock-only-auth-cookie-secret-2026-change-me \
npm run dev
```

Mock 관리자: `admin@vault-lab.local` / `LocalAdminPassword!2026`. 이 값은 로컬 Mock 전용입니다. Terraform 과정을 보려면 `COURSE_ID=terraform-foundations`를 추가하며, 관리자 이메일은 `admin@terraform-lab.local`입니다.

```bash
npm test
npm run build
```

## 문서

- [설치·배포·운영 가이드](OPERATIONS.ko.md)
- [Vault 네이티브 런타임](infra/native/README.md)
- [Terraform 운영 계약](docs/terraform-lab.md)
- [Terraform 네이티브 런타임](infra/terraform-native/README.md)
- [데스크톱 디자인](design/README.md)

## 범위와 제약사항

Mock 검증은 실제 Vault/Terraform 실행 검증을 대신하지 않습니다. 실환경에는 승인된 AMI 접근 권한, 전용 서브넷·보안그룹·IAM, HTTPS와 충분한 쿠키 서명 키가 필요합니다. 배포 스크립트는 허용된 AMI 소유자·이름·아키텍처를 검사하므로 임의의 AWS 이미지로 바로 실행할 수 없습니다. EC2·스토리지·네트워크 비용이 발생하며, 외부 연동이 필요한 과정은 별도 샌드박스를 준비해야 합니다.
