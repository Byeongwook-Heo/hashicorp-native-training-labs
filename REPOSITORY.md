# 저장소 관리 안내

Vault·Terraform 과정은 포털과 검증 서버를 공유합니다. 하나의 소스 저장소를 유지하되 과정별 AWS 배포 환경은 별도로 지정합니다.

- 기준 브랜치: `main`
- 공개 범위: 초기 분리는 비공개. 공개 전 조직 정책·라이선스·문서를 검토하세요.
- 원본: [IBM-Automation-HashiCorp](https://github.com/Byeongwook-Heo/IBM-Automation-HashiCorp), `Byeongwook-Heo/terraform-training-lab`
- 원본 기준 커밋: `de82fa46eea4028404ee7fa324f5d303718054f6`
- 추출 범위: `.`
- 개인 경로와 실제 접속 대상 기본값을 제거한 현재 소스 스냅샷으로 시작했습니다.
- 원본 저장소의 브랜치·PR·커밋 이력은 삭제하거나 다시 쓰지 않았습니다.

## 설정과 실행

README의 환경 변수와 Terraform 입력값을 먼저 지정하세요. `example.invalid`, `192.0.2.*`, `*-00000000000000000`는 실행 대상이 아닌 예시입니다. 승인 AMI 소유자 검증과 공개 배포 파일의 체크섬 검증은 유지했습니다. 조직 전용 AMI에는 해당 계정의 사용 권한이 필요합니다.

이번 정리는 소스와 문서에 한정됩니다. AWS 리소스 생성·변경, 운영 서비스 재시작, Secrets Manager·Vault 값 복사, GitHub Actions secret 복사는 하지 않았습니다. 원본의 CI/CD secret과 deploy key는 새 저장소로 자동 이전되지 않습니다.

## 커밋 금지 자료

실제 AWS 자격증명, 토큰, 비밀번호, 개인 키, 라이선스, Terraform state/plan, 개인 작업 경로는 커밋하지 마세요. 로컬 설정은 gitignore 대상에 보관하고 예제만 버전 관리합니다. 공개용 예제 토큰·테스트 fixture와 공개 키 체크섬은 실제 비밀값과 구분합니다.
