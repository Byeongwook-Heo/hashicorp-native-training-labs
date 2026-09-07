export type Step = {
  id: string;
  lab: number;
  title: string;
  objective: string;
  description: string;
  concept: string;
  command: string;
  expected: string;
  hint: string;
  troubleshooting: string[];
  success: string;
  validate: string[];
  expect: string[];
  /**
   * Trusted, server-only fixture executed with the validator token when a learner
   * skips this step. It must never be included in the public curriculum payload.
   */
  skipSetup: string[];
};

const marker = (id: string) => `verified:${id}`;

const shell = (script: string) => [
  "/bin/sh",
  "-c",
  `set -eu
${script.trim()}`
];

const verify = (id: string, script: string) => shell(`
${script}
printf '%s\\n' '${marker(id)}'
`);

const fixture = (script: string) => shell(script);
const noopFixture = () => shell(":");

const exactPolicyDraft = `printf '%s\\n' \
'path "training/data/myapp/config" {' \
'  capabilities = ["read"]' \
'}'`;

const ensureTrainingKv = `
if ! vault secrets list -format=json |
  jq -e 'has("training/")' >/dev/null; then
  vault secrets enable -path=training kv-v2 >/dev/null
fi
vault secrets list -format=json |
  jq -e '.[\"training/\"].type == "kv" and .[\"training/\"].options.version == "2"' >/dev/null
`;

const ensureKvV1 = `
${ensureTrainingKv}
vault kv metadata delete -mount=training myapp/config >/dev/null 2>&1 || true
vault kv put -mount=training -cas=0 myapp/config \
  username="app-user" password="InitialPass123!" >/dev/null
`;

const ensureKvV2 = `
${ensureKvV1}
vault kv put -mount=training -cas=1 myapp/config \
  username="app-user" password="RotatedPass456!" >/dev/null
`;

const ensurePolicy = `
${ensureKvV2}
${exactPolicyDraft} > /tmp/app-read.hcl
vault policy fmt /tmp/app-read.hcl >/dev/null
vault policy write app-read /tmp/app-read.hcl >/dev/null
`;

const createLimitedToken = `
${ensurePolicy}
umask 077
vault write -format=json auth/token/create/app-read-role \
  policies=app-read ttl=30m > /tmp/app-token.json
`;

const createTokenAudit = `
${createLimitedToken}
APP_TOKEN=$(jq -er '.auth.client_token | strings | select(length > 0)' /tmp/app-token.json)
vault token lookup -format=json "$APP_TOKEN" |
  jq '{policies: (.data.policies | sort), creation_ttl: .data.creation_ttl, ttl: .data.ttl, renewable: .data.renewable, orphan: .data.orphan, type: .data.type, path: .data.path}' \
  > /tmp/token-audit.json
`;

const ensureAppRole = `
${ensurePolicy}
if ! vault auth list -format=json |
  jq -e '.[\"approle/\"].type == "approle"' >/dev/null; then
  vault auth enable approle >/dev/null
fi
vault write auth/approle/role/demo-app \
  token_policies=app-read token_ttl=1h token_max_ttl=4h \
  token_type=service bind_secret_id=true \
  secret_id_num_uses=10 secret_id_ttl=10m >/dev/null
`;

const createAppRoleCredentials = `
${ensureAppRole}
umask 077
vault read -format=table -field=role_id auth/approle/role/demo-app/role-id > /tmp/role-id
vault write -format=json -f auth/approle/role/demo-app/secret-id > /tmp/secret-id.json
jq -er '.data.secret_id | strings | select(length > 0)' \
  /tmp/secret-id.json > /tmp/secret-id
`;

const createAppRoleLogin = `
${createAppRoleCredentials}
vault write -format=json auth/approle/login \
  role_id="$(cat /tmp/role-id)" secret_id="$(cat /tmp/secret-id)" \
  > /tmp/approle-login.json
`;

const ensureTransit = `
if ! vault secrets list -format=json |
  jq -e '.[\"transit/\"].type == "transit"' >/dev/null; then
  vault secrets enable transit >/dev/null
fi
`;

const ensureTransitKey = `
${ensureTransit}
vault write -f transit/keys/customer-data >/dev/null
`;

const createCiphertext = `
${ensureTransitKey}
umask 077
vault write -format=table -field=ciphertext transit/encrypt/customer-data \
  plaintext="$(printf 'customer-001@example.com' | base64)" > /tmp/ciphertext
`;

const ensureRotatedCiphertext = `
${createCiphertext}
LATEST=$(vault read -format=table -field=latest_version transit/keys/customer-data)
if [ "$LATEST" -lt 2 ]; then
  vault write -f transit/keys/customer-data/rotate >/dev/null
fi
vault write -format=table -field=ciphertext transit/rewrap/customer-data \
  ciphertext="$(cat /tmp/ciphertext)" > /tmp/ciphertext-v2
`;

const ensureAudit = `
vault audit list -format=json |
  jq -e '.[\"file/\"].type == "file" and .[\"file/\"].options.file_path == "/tmp/vault-audit.log" and .[\"file/\"].options.mode == "0640" and .[\"file/\"].options.log_raw == "false"' >/dev/null
`;

const ensurePki = `
if ! vault secrets list -format=json |
  jq -e '.[\"pki/\"].type == "pki"' >/dev/null; then
  vault secrets enable pki >/dev/null
fi
vault secrets tune -max-lease-ttl=8760h pki >/dev/null
`;

const ensurePkiRoot = `
${ensurePki}
if ! vault read -format=json pki/issuer/lab-root >/dev/null 2>&1; then
  vault write pki/root/generate/internal \
    issuer_name=lab-root common_name="example.internal" \
    key_type=rsa key_bits=2048 ttl=8760h >/dev/null
fi
`;

const ensurePkiRole = `
${ensurePkiRoot}
vault write pki/roles/internal-services \
  issuer_ref=lab-root \
  allowed_domains="example.internal" \
  allow_subdomains=true allow_bare_domains=false \
  allow_glob_domains=false allow_wildcard_certificates=false \
  allow_ip_sans=false allow_localhost=false \
  key_type=rsa key_bits=2048 max_ttl=1h >/dev/null
`;

const issueCertificate = `
${ensurePkiRole}
umask 077
vault write -format=json pki/issue/internal-services \
  common_name="api.example.internal" ttl=30m > /tmp/api-cert.json
`;

export const steps: Step[] = [
  {
    id: "status",
    lab: 1,
    title: "Vault 서버 상태 확인",
    objective: "초기화, 봉인, 스토리지 상태를 함께 해석할 수 있습니다.",
    description: "세션 전용 Vault가 초기화되고 unseal되어 요청을 처리할 수 있는지 확인합니다.",
    concept: "이 랩은 세션별 file storage를 사용합니다. 서버는 안전한 초기화 절차를 거쳐 unseal되며, 세션 종료 시 해당 스토리지가 폐기됩니다.",
    command: "vault status",
    expected: "Initialized true · Sealed false · Storage Type file",
    hint: "Initialized, Sealed, Storage Type 세 항목을 함께 확인하세요.",
    troubleshooting: ["connection refused라면 VAULT_ADDR를 확인하세요.", "Code 503은 Vault가 아직 sealed 상태일 수 있습니다."],
    success: "Vault 서버가 file storage로 초기화되고 unsealed 상태입니다.",
    validate: verify("status", `
vault status -format=json |
  jq -e '.initialized == true and .sealed == false and .storage_type == "file"' >/dev/null
`),
    expect: [marker("status")],
    skipSetup: noopFixture()
  },
  {
    id: "auth-list",
    lab: 1,
    title: "인증 방식 조사",
    objective: "활성화된 Auth Method와 mount 경로를 구분합니다.",
    description: "현재 활성화된 인증 방식을 상세 형식으로 조회하세요.",
    concept: "token/은 dev mode 전용 설정이 아니라 Vault core에 내장된 기본 Auth Method입니다. 모든 다른 인증 방식도 성공하면 결국 Vault 토큰을 발급합니다.",
    command: "vault auth list -detailed",
    expected: "token/ 경로와 Type token이 표시됩니다.",
    hint: "경로(Path)와 타입(Type)은 서로 다른 개념입니다.",
    troubleshooting: ["permission denied라면 현재 토큰에 sys/auth read 권한이 있는지 확인하세요."],
    success: "Vault core의 built-in token 인증 방식을 확인했습니다.",
    validate: verify("auth-list", `
vault auth list -format=json |
  jq -e '.[\"token/\"].type == "token"' >/dev/null
`),
    expect: [marker("auth-list")],
    skipSetup: noopFixture()
  },
  {
    id: "secrets-list",
    lab: 1,
    title: "Secrets Engine 조사",
    objective: "Secrets Engine과 Auth Method의 역할 차이를 설명할 수 있습니다.",
    description: "fresh native Vault에 기본으로 마운트된 Secrets Engine을 확인하세요.",
    concept: "일반 Vault 서버는 dev mode와 달리 secret/ KV를 자동으로 만들지 않습니다. cubbyhole/, identity/, sys/ 같은 core mount에서 시작해 필요한 업무용 엔진을 명시적으로 활성화합니다.",
    command: "vault secrets list -detailed",
    expected: "cubbyhole/, identity/, sys/가 표시됩니다. Vault 2.x edition에 따라 다른 core mount가 추가로 보일 수 있습니다.",
    hint: "secret/이 없어도 정상입니다. 다음 랩에서 training/ KV v2를 직접 만듭니다.",
    troubleshooting: ["auth list와 secrets list를 혼동하지 마세요.", "추가 mount는 Vault edition과 기능 활성화 상태에 따라 달라질 수 있습니다."],
    success: "fresh native Vault의 core Secrets Engine 구성을 확인했습니다.",
    validate: verify("secrets-list", `
vault secrets list -format=json |
  jq -e '.[\"cubbyhole/\"].type == "cubbyhole" and .[\"identity/\"].type == "identity" and .[\"sys/\"].type == "system"' >/dev/null
`),
    expect: [marker("secrets-list")],
    skipSetup: noopFixture()
  },
  {
    id: "enable-kv",
    lab: 2,
    title: "전용 KV v2 활성화",
    objective: "Secrets Engine을 원하는 경로에 정확한 버전으로 마운트할 수 있습니다.",
    description: "교육용 애플리케이션을 위한 KV v2 엔진을 training/ 경로에 활성화합니다.",
    concept: "KV v2는 비밀 버전, soft delete, undelete, destroy, Check-and-Set 기능을 제공합니다. type=kv뿐 아니라 options.version=2까지 확인해야 합니다.",
    command: `vault secrets list -format=json | jq -e '.[\"training/\"].type == "kv" and .[\"training/\"].options.version == "2"' >/dev/null 2>&1 || vault secrets enable -path=training kv-v2`,
    expected: "training/의 type은 kv, options.version은 2",
    hint: "명령은 이미 올바른 KV v2가 있으면 재사용하고, 없을 때만 활성화합니다.",
    troubleshooting: ["path is already in use인데 검증이 실패하면 같은 경로에 다른 엔진이나 KV v1이 있는지 확인하세요."],
    success: "training/에 KV v2가 정확히 활성화되었습니다.",
    validate: verify("enable-kv", `
vault secrets list -format=json |
  jq -e '.[\"training/\"].type == "kv" and .[\"training/\"].options.version == "2"' >/dev/null
`),
    expect: [marker("enable-kv")],
    skipSetup: fixture(ensureTrainingKv)
  },
  {
    id: "write-v1",
    lab: 2,
    title: "애플리케이션 비밀 v1 저장",
    objective: "CAS를 이용해 최초 비밀을 중복 없이 저장합니다.",
    description: "DB 사용자명과 비밀번호를 training/ KV v2의 첫 번째 버전으로 저장하세요.",
    concept: "cas=0은 아직 존재하지 않는 키에만 쓰기를 허용합니다. 명령을 실수로 반복해도 새 버전이 생기지 않아 실습 순서가 보존됩니다.",
    command: `vault kv put -mount=training -cas=0 myapp/config username="app-user" password="InitialPass123!"`,
    expected: "metadata.version 1",
    hint: "-mount=training 뒤에는 엔진 내부 경로 myapp/config만 적습니다.",
    troubleshooting: ["check-and-set parameter did not match는 비밀이 이미 있다는 뜻입니다.", "처음부터 다시 하려면 랩 세션 초기화를 사용하세요."],
    success: "첫 번째 버전의 애플리케이션 비밀이 정확히 저장되었습니다.",
    validate: verify("write-v1", `
vault kv get -mount=training -format=json myapp/config |
  jq -e '.data.metadata.version == 1 and .data.data == {"username":"app-user","password":"InitialPass123!"}' >/dev/null
`),
    expect: [marker("write-v1")],
    skipSetup: fixture(ensureKvV1)
  },
  {
    id: "write-v2",
    lab: 2,
    title: "비밀번호 회전",
    objective: "기대 버전을 고정해 안전하게 비밀을 회전합니다.",
    description: "버전 1을 전제로 사용자명은 유지하고 비밀번호를 RotatedPass456!로 변경하세요.",
    concept: "cas=1은 현재 버전이 정확히 1일 때만 새 버전을 만듭니다. 동시 업데이트나 명령 중복으로 인한 덮어쓰기를 막습니다.",
    command: `vault kv put -mount=training -cas=1 myapp/config username="app-user" password="RotatedPass456!"`,
    expected: "metadata.version 2",
    hint: "put은 전달하지 않은 기존 키를 보존하지 않으므로 username도 함께 적습니다.",
    troubleshooting: ["check-and-set 오류가 나면 현재 metadata.current_version을 확인하세요.", "명령을 이미 한 번 성공했다면 바로 검증을 실행하세요."],
    success: "두 번째 버전으로 비밀번호가 안전하게 회전되었습니다.",
    validate: verify("write-v2", `
vault kv get -mount=training -format=json myapp/config |
  jq -e '.data.metadata.version == 2 and .data.data == {"username":"app-user","password":"RotatedPass456!"}' >/dev/null
`),
    expect: [marker("write-v2")],
    skipSetup: fixture(ensureKvV2)
  },
  {
    id: "read-v1",
    lab: 2,
    title: "이전 버전 감사",
    objective: "특정 버전의 비밀을 명시적으로 조회합니다.",
    description: "회전 전 버전 1의 값을 조회해 변경 이력을 확인하세요.",
    concept: "버전 지정 조회는 장애 조사와 롤백 판단에 유용하지만, 오래된 자격 증명도 민감 정보이므로 접근 정책을 제한해야 합니다.",
    command: "vault kv get -mount=training -version=1 myapp/config",
    expected: "version 1 · password InitialPass123!",
    hint: "-mount와 -version을 모두 명시하면 KV v2 API 경로와 버전 의도가 분명해집니다.",
    troubleshooting: ["version not found라면 v1 저장 단계를 다시 확인하세요."],
    success: "버전 1의 원래 값을 확인했습니다.",
    validate: verify("read-v1", `
vault kv get -mount=training -version=1 -format=json myapp/config |
  jq -e '.data.metadata.version == 1 and .data.data.username == "app-user" and .data.data.password == "InitialPass123!"' >/dev/null
`),
    expect: [marker("read-v1")],
    skipSetup: fixture(ensureKvV2)
  },
  {
    id: "kv-soft-delete",
    lab: 2,
    title: "버전 2 Soft delete",
    objective: "복구 가능한 삭제 상태를 직접 확인합니다.",
    description: "버전 2를 soft delete한 뒤 해당 버전을 읽을 수 없는 상태로 만드세요.",
    concept: "KV v2 delete는 암호화된 데이터를 즉시 파기하지 않고 deletion_time을 기록해 읽기를 차단합니다. destroy와 달리 undelete가 가능합니다.",
    command: "vault kv delete -mount=training -versions=2 myapp/config",
    expected: "version 2의 deletion_time이 설정되고 조회가 차단됩니다.",
    hint: "이 단계에서는 아직 undelete하지 마세요. 삭제 상태 자체를 서버가 검증합니다.",
    troubleshooting: ["version not found라면 v2 회전 단계를 확인하세요.", "destroy를 사용하면 복구할 수 없으므로 사용하지 마세요."],
    success: "버전 2가 복구 가능한 soft-delete 상태입니다.",
    validate: verify("kv-soft-delete", `
vault kv metadata get -mount=training -format=json myapp/config |
  jq -e '.data.versions["2"].deletion_time != "" and .data.versions["2"].destroyed == false' >/dev/null
vault kv get -mount=training -version=2 -format=json myapp/config |
  jq -e '.data.data == null and .data.metadata.version == 2 and .data.metadata.deletion_time != "" and .data.metadata.destroyed == false' >/dev/null
`),
    expect: [marker("kv-soft-delete")],
    skipSetup: fixture(`
${ensureKvV2}
vault kv delete -mount=training -versions=2 myapp/config >/dev/null
`)
  },
  {
    id: "kv-restore",
    lab: 2,
    title: "Soft delete 복구",
    objective: "삭제된 버전을 undelete하고 원래 데이터를 검증합니다.",
    description: "soft delete된 버전 2를 복구하세요.",
    concept: "undelete는 deletion_time을 제거해 기존 ciphertext를 다시 읽을 수 있게 합니다. 영구 파기인 destroy에는 적용할 수 없습니다.",
    command: "vault kv undelete -mount=training -versions=2 myapp/config",
    expected: "version 2의 deletion_time이 비워지고 RotatedPass456!가 다시 조회됩니다.",
    hint: "복구 후 특정 버전 2를 지정해 값을 확인할 수 있습니다.",
    troubleshooting: ["destroyed=true라면 undelete할 수 없습니다.", "복구되지 않으면 versions=2가 맞는지 확인하세요."],
    success: "버전 2가 정상 복구되고 원래 값이 유지되었습니다.",
    validate: verify("kv-restore", `
vault kv metadata get -mount=training -format=json myapp/config |
  jq -e '.data.versions["2"].deletion_time == "" and .data.versions["2"].destroyed == false' >/dev/null
vault kv get -mount=training -version=2 -format=json myapp/config |
  jq -e '.data.data == {"username":"app-user","password":"RotatedPass456!"}' >/dev/null
`),
    expect: [marker("kv-restore")],
    skipSetup: fixture(`
${ensureKvV2}
vault kv delete -mount=training -versions=2 myapp/config >/dev/null
vault kv undelete -mount=training -versions=2 myapp/config >/dev/null
`)
  },
  {
    id: "policy-write",
    lab: 3,
    title: "최소 권한 Policy 초안 검증",
    objective: "정확한 KV v2 API 경로만 허용하는 ACL Policy 초안을 작성합니다.",
    description: "/tmp/app-read.hcl에 단일 비밀의 read 권한만 담은 안전한 초안을 작성하세요.",
    concept: "교육생 토큰에는 서버 Policy 변경 권한이 없습니다. 서버 검증기가 초안이 canonical 내용과 정확히 같은지 확인한 뒤 trusted root 경계에서 app-read를 적용합니다.",
    command: `${exactPolicyDraft} > /tmp/app-read.hcl && vault policy fmt /tmp/app-read.hcl >/dev/null`,
    expected: "초안에는 training/data/myapp/config의 read capability만 존재하며 검증 후 서버가 app-read로 적용합니다.",
    hint: "파일 경로의 data/는 KV v2 API 경로이며 capabilities에는 read 하나만 둡니다.",
    troubleshooting: ["HCL 포맷 오류가 나면 따옴표와 중괄호를 확인하세요.", "wildcard(*)나 create/update가 들어가면 검증되지 않습니다."],
    success: "정확한 단일 경로에 read만 허용하는 초안이 검증되고 서버에 안전하게 적용되었습니다.",
    validate: verify("policy-write", `
EXPECTED=$(${exactPolicyDraft})
[ "$(cat /tmp/app-read.hcl)" = "$EXPECTED" ]
${exactPolicyDraft} | vault policy write app-read - >/dev/null
INSTALLED=$(vault policy read -format=json app-read | jq -er '.policy')
[ "$INSTALLED" = "$EXPECTED" ]
`),
    expect: [marker("policy-write")],
    skipSetup: fixture(ensurePolicy)
  },
  {
    id: "capabilities",
    lab: 3,
    title: "권한 시뮬레이션",
    objective: "제한된 token role로 발급한 토큰의 실제 권한을 검사합니다.",
    description: "bootstrap된 app-read-role로 단기 토큰을 발급해 허용 경로의 capability를 확인하세요.",
    concept: "교육생은 token role을 수정할 수 없고 안전하게 bootstrap된 role만 사용할 수 있습니다. 역할은 정책·TTL·토큰 유형의 상한을 서버에서 강제합니다.",
    command: `TOKEN_JSON=$(vault write -format=json auth/token/create/app-read-role policies=app-read ttl=5m) && APP_TOKEN=$(printf '%s' "$TOKEN_JSON" | jq -er '.auth.client_token') && ACCESSOR=$(printf '%s' "$TOKEN_JSON" | jq -er '.auth.accessor') && VAULT_TOKEN="$APP_TOKEN" vault token capabilities training/data/myapp/config && vault token revoke -accessor "$ACCESSOR" >/dev/null`,
    expected: "read",
    hint: "API 경로 training/data/myapp/config에서 정확히 read만 출력되어야 합니다.",
    troubleshooting: ["permission denied면 app-read 정책과 app-read-role bootstrap 상태를 확인하세요.", "deny가 나오면 정책의 data/ 경로를 확인하세요."],
    success: "허용 경로에는 read만, 다른 경로에는 deny가 적용됩니다.",
    validate: verify("capabilities", `
APP_TOKEN=$(vault write -format=json auth/token/create/app-read-role policies=app-read ttl=2m |
  jq -er '.auth.client_token')
trap 'vault token revoke "$APP_TOKEN" >/dev/null 2>&1 || true' EXIT
VAULT_TOKEN="$APP_TOKEN" vault token capabilities -format=json training/data/myapp/config |
  jq -e '. == ["read"]' >/dev/null
VAULT_TOKEN="$APP_TOKEN" vault token capabilities -format=json training/data/myapp/blocked |
  jq -e '. == ["deny"]' >/dev/null
`),
    expect: [marker("capabilities")],
    skipSetup: fixture(ensurePolicy)
  },
  {
    id: "limited-token",
    lab: 3,
    title: "제한된 서비스 Token 발급",
    objective: "서버가 강제하는 정책과 수명을 가진 토큰을 안전한 파일 권한으로 발급합니다.",
    description: "app-read-role을 통해 30분 TTL 토큰을 /tmp/app-token.json에 저장하세요.",
    concept: "role 기반 발급은 호출자가 임의로 더 강한 정책이나 긴 수명을 요청하지 못하게 합니다. 실습 파일은 umask 077로 다른 사용자에게 노출되지 않게 만듭니다.",
    command: `umask 077; vault write -format=json auth/token/create/app-read-role policies=app-read ttl=30m > /tmp/app-token.json`,
    expected: "/tmp/app-token.json mode 0600 · app-read/default 정책 · 최대 30분 · non-renewable service token",
    hint: "토큰 원문을 화면이나 로그에 다시 출력하지 마세요.",
    troubleshooting: ["role not found면 실습 세션을 초기화해 bootstrap 상태를 복구하세요.", "permission denied면 role 전용 create 경로 권한을 확인하세요."],
    success: "서버가 제한한 정책과 TTL을 가진 서비스 토큰이 안전하게 저장되었습니다.",
    validate: verify("limited-token", `
test -s /tmp/app-token.json
[ "$(stat -c %a /tmp/app-token.json)" = "600" ]
APP_TOKEN=$(jq -er '.auth.client_token | strings | select(length > 0)' /tmp/app-token.json)
ROLE=$(vault read -format=json auth/token/roles/app-read-role)
printf '%s' "$ROLE" |
  jq -e '.data.allowed_policies == ["app-read"] and (.data.disallowed_policies | index("root") != null) and .data.orphan == false and .data.renewable == false and .data.token_explicit_max_ttl == 1800 and .data.token_type == "service" and .data.token_no_default_policy == false' >/dev/null
LOOKUP=$(vault token lookup -format=json "$APP_TOKEN")
printf '%s' "$LOOKUP" |
  jq -e '.data.policies == ["app-read","default"] or .data.policies == ["default","app-read"]' >/dev/null
printf '%s' "$LOOKUP" |
  jq -e '.data.creation_ttl > 0 and .data.creation_ttl <= 1800 and .data.ttl > 0 and .data.ttl <= 1800 and .data.renewable == false and .data.orphan == false and .data.type == "service" and .data.path == "auth/token/create/app-read-role"' >/dev/null
`),
    expect: [marker("limited-token")],
    skipSetup: fixture(createLimitedToken)
  },
  {
    id: "token-lookup",
    lab: 3,
    title: "Token 속성 감사",
    objective: "토큰 원문을 노출하지 않고 policies, TTL, 갱신 가능 여부를 구조적으로 검사합니다.",
    description: "저장한 토큰을 lookup하고 필요한 속성만 /tmp/token-audit.json에 남기세요.",
    concept: "lookup은 현재 ttl뿐 아니라 creation_ttl, explicit_max_ttl, renewable, orphan, path를 함께 봐야 role의 제한이 실제 토큰에 반영됐는지 알 수 있습니다.",
    command: `APP_TOKEN=$(jq -er '.auth.client_token' /tmp/app-token.json); vault token lookup -format=json "$APP_TOKEN" | jq '{policies: (.data.policies | sort), creation_ttl: .data.creation_ttl, ttl: .data.ttl, renewable: .data.renewable, orphan: .data.orphan, type: .data.type, path: .data.path}' | tee /tmp/token-audit.json`,
    expected: "policies [app-read, default] · ttl ≤ 1800 · renewable false · orphan false · type service",
    hint: "jq 결과에는 client_token이나 id를 포함하지 않습니다.",
    troubleshooting: ["파일이 없다면 제한 토큰 단계를 다시 실행하세요.", "토큰이 만료됐다면 새 토큰을 발급하세요."],
    success: "민감한 토큰 원문 없이 제한 속성을 감사했습니다.",
    validate: verify("token-lookup", `
APP_TOKEN=$(jq -er '.auth.client_token | strings | select(length > 0)' /tmp/app-token.json)
LOOKUP=$(vault token lookup -format=json "$APP_TOKEN")
AUDIT=$(cat /tmp/token-audit.json)
printf '%s' "$AUDIT" |
  jq -e '.policies == ["app-read","default"] and .creation_ttl > 0 and .creation_ttl <= 1800 and .ttl > 0 and .ttl <= 1800 and .renewable == false and .orphan == false and .type == "service" and .path == "auth/token/create/app-read-role"' >/dev/null
printf '%s' "$LOOKUP" |
  jq -e '.data.policies | sort == ["app-read","default"]' >/dev/null
`),
    expect: [marker("token-lookup")],
    skipSetup: fixture(createTokenAudit)
  },
  {
    id: "approle-enable",
    lab: 4,
    title: "AppRole 인증 활성화",
    objective: "머신 워크로드용 인증 방식을 idempotent하게 활성화합니다.",
    description: "AppRole Auth Method를 기본 approle/ 경로에 활성화하세요.",
    concept: "AppRole은 RoleID와 SecretID를 서로 다른 전달 경로로 제공해 비대화형 워크로드가 제한된 Vault 토큰을 얻도록 합니다.",
    command: `vault auth list -format=json | jq -e '.[\"approle/\"].type == "approle"' >/dev/null 2>&1 || vault auth enable approle`,
    expected: "approle/ type approle",
    hint: "이미 올바르게 활성화된 경우 추가 변경 없이 성공합니다.",
    troubleshooting: ["auth method 활성화에는 sudo capability가 필요합니다.", "같은 경로에 다른 auth type이 있으면 세션을 초기화하세요."],
    success: "AppRole 인증 방식이 활성화되었습니다.",
    validate: verify("approle-enable", `
vault auth list -format=json |
  jq -e '.[\"approle/\"].type == "approle"' >/dev/null
`),
    expect: [marker("approle-enable")],
    skipSetup: fixture(`
if ! vault auth list -format=json |
  jq -e '.[\"approle/\"].type == "approle"' >/dev/null; then
  vault auth enable approle >/dev/null
fi
`)
  },
  {
    id: "approle-role",
    lab: 4,
    title: "애플리케이션 Role 구성",
    objective: "AppRole에 정책, Token TTL, SecretID 제약을 함께 적용합니다.",
    description: "app-read 정책을 사용하고 SecretID가 10분·10회로 제한된 demo-app 역할을 생성하세요.",
    concept: "Role은 인증 후 발급될 token의 정책과 수명뿐 아니라 SecretID의 수명·사용 횟수도 제한합니다.",
    command: `vault write auth/approle/role/demo-app token_policies=app-read token_ttl=1h token_max_ttl=4h token_type=service bind_secret_id=true secret_id_num_uses=10 secret_id_ttl=10m`,
    expected: "token_ttl 3600 · token_max_ttl 14400 · secret_id_ttl 600 · secret_id_num_uses 10",
    hint: "bind_secret_id=true로 RoleID만으로는 로그인할 수 없게 합니다.",
    troubleshooting: ["no handler for route라면 AppRole을 먼저 활성화하세요.", "app-read 정책이 없다면 정책 단계를 스킵 또는 완료하세요."],
    success: "demo-app 역할에 정책과 이중 수명 제한이 적용되었습니다.",
    validate: verify("approle-role", `
vault read -format=json auth/approle/role/demo-app |
  jq -e '.data.token_policies == ["app-read"] and .data.token_ttl == 3600 and .data.token_max_ttl == 14400 and .data.token_type == "service" and .data.bind_secret_id == true and .data.secret_id_num_uses == 10 and .data.secret_id_ttl == 600' >/dev/null
`),
    expect: [marker("approle-role")],
    skipSetup: fixture(ensureAppRole)
  },
  {
    id: "approle-credentials",
    lab: 4,
    title: "RoleID와 SecretID 발급",
    objective: "AppRole 로그인 재료와 SecretID 제약을 함께 검증합니다.",
    description: "RoleID와 새 SecretID를 mode 0600 임시 파일에 분리해 저장하세요.",
    concept: "RoleID는 식별자이고 SecretID는 비밀입니다. SecretID lookup을 사용하면 원문을 노출하지 않고 TTL과 남은 사용 횟수를 검사할 수 있습니다.",
    command: `umask 077; vault read -format=table -field=role_id auth/approle/role/demo-app/role-id > /tmp/role-id && vault write -format=json -f auth/approle/role/demo-app/secret-id > /tmp/secret-id.json && jq -er '.data.secret_id' /tmp/secret-id.json > /tmp/secret-id`,
    expected: "RoleID/SecretID 파일 mode 0600 · SecretID TTL 600 · 사용 횟수 10",
    hint: "SecretID JSON에는 검증용 accessor도 포함되며 원문 파일은 화면에 출력하지 않습니다.",
    troubleshooting: ["빈 파일이면 demo-app 역할이 존재하는지 확인하세요.", "SecretID가 만료됐다면 새로 발급하세요."],
    success: "RoleID와 제한된 SecretID가 안전한 파일 권한으로 발급되었습니다.",
    validate: verify("approle-credentials", `
test -s /tmp/role-id
test -s /tmp/secret-id
test -s /tmp/secret-id.json
[ "$(stat -c %a /tmp/role-id)" = "600" ]
[ "$(stat -c %a /tmp/secret-id)" = "600" ]
[ "$(vault read -format=table -field=role_id auth/approle/role/demo-app/role-id)" = "$(cat /tmp/role-id)" ]
SECRET_ID=$(cat /tmp/secret-id)
LOOKUP=$(vault write -format=json auth/approle/role/demo-app/secret-id/lookup secret_id="$SECRET_ID")
printf '%s' "$LOOKUP" |
  jq -e '.data.secret_id_num_uses == 10 and .data.secret_id_ttl > 0 and .data.secret_id_ttl <= 600' >/dev/null
`),
    expect: [marker("approle-credentials")],
    skipSetup: fixture(createAppRoleCredentials)
  },
  {
    id: "approle-login",
    lab: 4,
    title: "머신 로그인 수행",
    objective: "AppRole 자격 증명으로 제한된 서비스 토큰을 발급받습니다.",
    description: "저장한 RoleID와 SecretID로 로그인하고 응답을 /tmp/approle-login.json에 저장하세요.",
    concept: "AppRole login은 역할에 연결된 정책과 수명을 가진 새 토큰을 반환합니다. 서버 검증은 SecretID를 추가 소비하지 않고 발급된 토큰 자체를 lookup합니다.",
    command: `vault write -format=json auth/approle/login role_id="$(cat /tmp/role-id)" secret_id="$(cat /tmp/secret-id)" > /tmp/approle-login.json && jq '{policies: (.auth.policies | sort), ttl: .auth.lease_duration, renewable: .auth.renewable, type: .auth.token_type}' /tmp/approle-login.json`,
    expected: "policies [app-read, default] · ttl ≤ 3600 · type service",
    hint: "SecretID 한 번을 소비하므로 성공 응답 파일을 재사용해 검증합니다.",
    troubleshooting: ["invalid role or secret ID면 파일 값·만료·사용 횟수를 확인하세요.", "응답 파일은 토큰을 포함하므로 mode 0600을 유지하세요."],
    success: "AppRole 인증으로 제한된 서비스 토큰을 발급받았습니다.",
    validate: verify("approle-login", `
test -s /tmp/approle-login.json
[ "$(stat -c %a /tmp/approle-login.json)" = "600" ]
APP_TOKEN=$(jq -er '.auth.client_token | strings | select(length > 0)' /tmp/approle-login.json)
printf '%s' "$(vault token lookup -format=json "$APP_TOKEN")" |
  jq -e '(.data.policies | sort) == ["app-read","default"] and .data.creation_ttl > 0 and .data.creation_ttl <= 3600 and .data.ttl > 0 and .data.ttl <= 3600 and .data.path == "auth/approle/login" and .data.type == "service"' >/dev/null
`),
    expect: [marker("approle-login")],
    skipSetup: fixture(createAppRoleLogin)
  },
  {
    id: "transit-enable",
    lab: 5,
    title: "Transit Engine 활성화",
    objective: "데이터를 저장하지 않는 암호화 서비스를 구성합니다.",
    description: "transit/ 경로에 Transit Secrets Engine을 idempotent하게 활성화하세요.",
    concept: "Transit은 애플리케이션 데이터를 Vault에 저장하지 않고 암복호화·서명·HMAC 기능을 제공합니다. Vault는 키 수명주기만 관리합니다.",
    command: `vault secrets list -format=json | jq -e '.[\"transit/\"].type == "transit"' >/dev/null 2>&1 || vault secrets enable transit`,
    expected: "transit/ type transit",
    hint: "이미 올바른 mount가 있으면 추가 변경하지 않습니다.",
    troubleshooting: ["path is already in use인데 검증이 실패하면 동일 경로의 engine type을 확인하세요."],
    success: "Transit 암호화 서비스가 활성화되었습니다.",
    validate: verify("transit-enable", `
vault secrets list -format=json |
  jq -e '.[\"transit/\"].type == "transit"' >/dev/null
`),
    expect: [marker("transit-enable")],
    skipSetup: fixture(ensureTransit)
  },
  {
    id: "transit-key",
    lab: 5,
    title: "암호화 키 생성",
    objective: "내보낼 수 없는 AES-GCM 관리형 키를 생성합니다.",
    description: "customer-data라는 aes256-gcm96 키를 생성하세요.",
    concept: "Transit의 기본 AES-GCM 키는 인증 암호화를 제공하고 plaintext export를 허용하지 않습니다.",
    command: "vault write -f transit/keys/customer-data",
    expected: "name customer-data · type aes256-gcm96 · latest_version 1 · exportable false",
    hint: "-f는 본문 없이 쓰기 요청을 전송하며 기존 키에는 안전한 no-op입니다.",
    troubleshooting: ["unsupported path라면 transit 엔진 활성화를 확인하세요."],
    success: "내보낼 수 없는 AES-GCM 관리형 키가 준비되었습니다.",
    validate: verify("transit-key", `
vault read -format=json transit/keys/customer-data |
  jq -e '.data.name == "customer-data" and .data.type == "aes256-gcm96" and .data.latest_version >= 1 and .data.exportable == false and .data.allow_plaintext_backup == false and .data.supports_encryption == true and .data.supports_decryption == true' >/dev/null
`),
    expect: [marker("transit-key")],
    skipSetup: fixture(ensureTransitKey)
  },
  {
    id: "transit-encrypt",
    lab: 5,
    title: "고객 데이터 암호화",
    objective: "Base64 입력을 Transit ciphertext로 변환하고 실제 복호화 가능성을 검증합니다.",
    description: "customer-001@example.com을 암호화해 /tmp/ciphertext에 저장하세요.",
    concept: "Transit plaintext 입력은 Base64이고 반환 ciphertext는 vault:vN: 형식입니다. prefix만 보지 않고 같은 키로 원문이 복원되는지 검증해야 합니다.",
    command: `umask 077; vault write -format=table -field=ciphertext transit/encrypt/customer-data plaintext="$(printf 'customer-001@example.com' | base64)" > /tmp/ciphertext`,
    expected: "vault:v1: ciphertext이며 복호화 결과는 customer-001@example.com",
    hint: "암호문 파일은 다음 단계에서 사용하므로 삭제하지 마세요.",
    troubleshooting: ["invalid base64면 printf와 base64 명령 치환을 확인하세요.", "파일이 비어 있으면 transit key 상태를 확인하세요."],
    success: "ciphertext 형식과 실제 원문 복호화가 모두 검증되었습니다.",
    validate: verify("transit-encrypt", `
CIPHERTEXT=$(cat /tmp/ciphertext)
case "$CIPHERTEXT" in vault:v1:*) ;; *) exit 1 ;; esac
PLAINTEXT=$(vault write -format=table -field=plaintext transit/decrypt/customer-data ciphertext="$CIPHERTEXT" | base64 -d)
[ "$PLAINTEXT" = "customer-001@example.com" ]
`),
    expect: [marker("transit-encrypt")],
    skipSetup: fixture(createCiphertext)
  },
  {
    id: "transit-decrypt",
    lab: 5,
    title: "암호문 복호화",
    objective: "허가된 경로에서 ciphertext를 원문으로 복호화합니다.",
    description: "저장한 암호문을 복호화해 원문을 화면과 /tmp/decrypted.txt에서 확인하세요.",
    concept: "애플리케이션은 ciphertext만 저장하고, 허가된 런타임만 Transit decrypt 권한으로 평문을 얻도록 설계할 수 있습니다.",
    command: `vault write -format=table -field=plaintext transit/decrypt/customer-data ciphertext="$(cat /tmp/ciphertext)" | base64 -d | tee /tmp/decrypted.txt`,
    expected: "customer-001@example.com",
    hint: "Vault가 반환하는 plaintext도 Base64이므로 마지막에 디코딩합니다.",
    troubleshooting: ["ciphertext cannot be decoded면 파일 내용과 키 이름을 확인하세요."],
    success: "암호문을 원래 고객 데이터로 복호화했습니다.",
    validate: verify("transit-decrypt", `
[ "$(cat /tmp/decrypted.txt)" = "customer-001@example.com" ]
[ "$(vault write -format=table -field=plaintext transit/decrypt/customer-data ciphertext="$(cat /tmp/ciphertext)" | base64 -d)" = "customer-001@example.com" ]
`),
    expect: [marker("transit-decrypt")],
    skipSetup: fixture(`
${createCiphertext}
printf '%s' 'customer-001@example.com' > /tmp/decrypted.txt
`)
  },
  {
    id: "transit-rotate",
    lab: 5,
    title: "키 회전과 암호문 재래핑",
    objective: "키를 한 번만 회전하고 기존 암호문을 현재 키 버전으로 rewrap합니다.",
    description: "customer-data를 최소 v2로 회전한 뒤 기존 ciphertext를 현재 키 버전으로 재래핑하세요.",
    concept: "rewrap은 평문을 애플리케이션에 노출하지 않고 ciphertext 버전을 갱신합니다. 명령은 재실행 시 불필요한 추가 회전을 하지 않습니다.",
    command: `LATEST=$(vault read -format=table -field=latest_version transit/keys/customer-data); if [ "$LATEST" -lt 2 ]; then vault write -f transit/keys/customer-data/rotate >/dev/null; fi; vault write -format=table -field=ciphertext transit/rewrap/customer-data ciphertext="$(cat /tmp/ciphertext)" > /tmp/ciphertext-v2`,
    expected: "ciphertext의 vault:vN: 버전이 current latest_version과 같고 원문은 유지됩니다.",
    hint: "rotate 후 latest_version을 읽어 ciphertext prefix와 비교하세요.",
    troubleshooting: ["v1이면 rotate가 성공했는지 확인하세요.", "직접 여러 번 회전했더라도 현재 버전으로 rewrap하면 검증됩니다."],
    success: "현재 키 버전으로 재래핑되고 원문이 유지되었습니다.",
    validate: verify("transit-rotate", `
LATEST=$(vault read -format=table -field=latest_version transit/keys/customer-data)
[ "$LATEST" -ge 2 ]
CIPHERTEXT=$(cat /tmp/ciphertext-v2)
case "$CIPHERTEXT" in "vault:v$LATEST:"*) ;; *) exit 1 ;; esac
[ "$(vault write -format=table -field=plaintext transit/decrypt/customer-data ciphertext="$CIPHERTEXT" | base64 -d)" = "customer-001@example.com" ]
`),
    expect: [marker("transit-rotate")],
    skipSetup: fixture(ensureRotatedCiphertext)
  },
  {
    id: "audit-enable",
    lab: 6,
    title: "Audit Device 안전 구성 확인",
    objective: "신뢰된 bootstrap이 만든 감사 장치의 경로·권한·raw logging 차단을 검증합니다.",
    description: "교육 세션 전용 file Audit Device가 안전한 고정 설정으로 준비되었는지 확인하세요.",
    concept: "감사 장치 변경 권한은 root token 같은 민감 요청을 raw socket이나 임의 파일로 빼낼 수 있어 학습자 토큰에서 제외됩니다. 이 랩은 신뢰된 bootstrap이 /tmp/vault-audit.log, mode 0640, log_raw=false를 고정합니다.",
    command: `vault audit list -format=json | jq -e '.[\"file/\"].type == "file" and .[\"file/\"].options.file_path == "/tmp/vault-audit.log" and .[\"file/\"].options.mode == "0640" and .[\"file/\"].options.log_raw == "false"'`,
    expected: "file/ type file · 고정 경로 · mode 0640 · log_raw false",
    hint: "운영 환경에서는 감사 장치 구성 권한과 로그 읽기 권한도 분리하고 독립 장치를 둘 이상 사용합니다.",
    troubleshooting: ["permission denied면 sys/audit read+sudo 권한을 확인하세요.", "설정이 다르면 세션을 초기화해 trusted bootstrap을 다시 실행하세요."],
    success: "세션 전용 Audit Device가 raw secret 노출 없이 안전하게 고정되었습니다.",
    validate: verify("audit-enable", `
vault audit list -format=json |
  jq -e '.[\"file/\"].type == "file" and .[\"file/\"].options.file_path == "/tmp/vault-audit.log" and .[\"file/\"].options.mode == "0640" and .[\"file/\"].options.log_raw == "false"' >/dev/null
test -e /tmp/vault-audit.log
`),
    expect: [marker("audit-enable")],
    skipSetup: fixture(ensureAudit)
  },
  {
    id: "audit-inspect",
    lab: 6,
    title: "감사 이벤트 추적",
    objective: "하나의 요청을 동일 request.id의 request·response 쌍으로 연결합니다.",
    description: "KV 비밀을 조회한 뒤 같은 request.id를 가진 감사 이벤트 쌍을 확인하세요.",
    concept: "KV CLI 경로 myapp/config는 감사 로그에서 training/data/myapp/config로 기록됩니다. request.id로 묶어야 무관한 response를 잘못 연결하지 않습니다.",
    command: `vault kv get -mount=training myapp/config >/dev/null && jq -c 'select(.request.path == "training/data/myapp/config") | {type: .type, request_id: .request.id, path: .request.path}' /tmp/vault-audit.log | tail -n 2 | tee /tmp/audit-trace.jsonl`,
    expected: "동일 request_id와 path를 가진 request/response JSONL 두 줄",
    hint: "감사 로그의 client_token과 민감 값은 HMAC으로 표시되는 것이 정상입니다.",
    troubleshooting: ["파일이 비어 있으면 Audit Device 상태를 확인하세요.", "응답만 보이면 request_id로 전체 로그를 다시 검색하세요."],
    success: "KV 요청의 request·response 쌍을 동일 request.id로 추적했습니다.",
    validate: verify("audit-inspect", `
test -s /tmp/vault-audit.log
jq -s -e '
  [.[] | select(.request.path == "training/data/myapp/config")]
  | group_by(.request.id)
  | any(.[]; (([.[].type] | index("request")) != null) and (([.[].type] | index("response")) != null))
' /tmp/vault-audit.log >/dev/null
jq -s -e '
  length == 2 and
  (map(.type) | sort) == ["request","response"] and
  .[0].request_id == .[1].request_id and
  all(.[]; .path == "training/data/myapp/config")
' /tmp/audit-trace.jsonl >/dev/null
`),
    expect: [marker("audit-inspect")],
    skipSetup: fixture(`
${ensureKvV2}
${ensureAudit}
vault kv get -mount=training myapp/config >/dev/null
jq -c 'select(.request.path == "training/data/myapp/config") | {type: .type, request_id: .request.id, path: .request.path}' \
  /tmp/vault-audit.log | tail -n 2 > /tmp/audit-trace.jsonl
`)
  },
  {
    id: "deny-drill",
    lab: 6,
    title: "권한 거부 장애 훈련",
    objective: "정확한 read-only 토큰으로 쓰기 거부를 재현하고 증거를 구조화합니다.",
    description: "app-read-role 토큰으로 허용되지 않은 경로에 쓰기를 시도해 permission denied를 기록하세요.",
    concept: "HTTP 403은 서버 장애가 아니라 token policy, namespace, mount, API path가 맞지 않을 때 자주 발생합니다. 먼저 capabilities를 확인한 뒤 실제 요청 결과를 연결합니다.",
    command: `rm -f /tmp/denied.out /tmp/deny-proof.json; TOKEN_JSON=$(vault write -format=json auth/token/create/app-read-role policies=app-read ttl=5m) && READ_TOKEN=$(printf '%s' "$TOKEN_JSON" | jq -er '.auth.client_token') && ACCESSOR=$(printf '%s' "$TOKEN_JSON" | jq -er '.auth.accessor') && test "$(VAULT_TOKEN="$READ_TOKEN" vault token capabilities training/data/myapp/config)" = "read" && test "$(VAULT_TOKEN="$READ_TOKEN" vault token capabilities training/data/myapp/blocked)" = "deny" && if VAULT_TOKEN="$READ_TOKEN" vault kv put -mount=training myapp/blocked value=no > /tmp/denied.out 2>&1; then vault token revoke -accessor "$ACCESSOR" >/dev/null; false; else grep -qi 'permission denied' /tmp/denied.out && printf '%s\\n' '{"path":"training/data/myapp/blocked","capability":"deny","result":"permission denied"}' > /tmp/deny-proof.json; fi && vault token revoke -accessor "$ACCESSOR" >/dev/null`,
    expected: "허용 경로 read · 차단 경로 deny · 실제 요청 permission denied",
    hint: "명령은 이전 증거 파일을 먼저 지우므로 이번 시도의 결과만 검증합니다.",
    troubleshooting: ["token 발급 실패를 무시하지 마세요.", "쓰기 성공 시 app-read 정책이나 bootstrap role이 과도하게 넓은지 확인하세요."],
    success: "읽기 전용 토큰의 쓰기 요청이 정확한 정책 사유로 거부되었습니다.",
    validate: verify("deny-drill", `
jq -e '. == {"path":"training/data/myapp/blocked","capability":"deny","result":"permission denied"}' /tmp/deny-proof.json >/dev/null
grep -qi 'permission denied' /tmp/denied.out
READ_TOKEN=$(vault write -format=json auth/token/create/app-read-role policies=app-read ttl=2m |
  jq -er '.auth.client_token')
trap 'vault token revoke "$READ_TOKEN" >/dev/null 2>&1 || true' EXIT
VAULT_TOKEN="$READ_TOKEN" vault token capabilities -format=json training/data/myapp/config |
  jq -e '. == ["read"]' >/dev/null
VAULT_TOKEN="$READ_TOKEN" vault token capabilities -format=json training/data/myapp/blocked |
  jq -e '. == ["deny"]' >/dev/null
if VAULT_TOKEN="$READ_TOKEN" vault kv put -mount=training myapp/blocked value=no >/dev/null 2>&1; then
  exit 1
fi
`),
    expect: [marker("deny-drill")],
    skipSetup: fixture(`
${ensurePolicy}
rm -f /tmp/denied.out /tmp/deny-proof.json
READ_TOKEN=$(vault write -format=json auth/token/create/app-read-role policies=app-read ttl=2m |
  jq -er '.auth.client_token')
if VAULT_TOKEN="$READ_TOKEN" vault kv put -mount=training myapp/blocked value=no > /tmp/denied.out 2>&1; then
  vault token revoke "$READ_TOKEN" >/dev/null
  exit 1
fi
grep -qi 'permission denied' /tmp/denied.out
printf '%s\\n' '{"path":"training/data/myapp/blocked","capability":"deny","result":"permission denied"}' > /tmp/deny-proof.json
vault token revoke "$READ_TOKEN" >/dev/null
`)
  },
  {
    id: "revoke-drill",
    lab: 6,
    title: "Token accessor 폐기 대응",
    objective: "토큰 원문 대신 accessor로 노출된 토큰을 폐기합니다.",
    description: "제한 토큰과 accessor를 발급한 뒤 accessor로 revoke하고 token/accessor lookup 실패를 증명하세요.",
    concept: "accessor는 인증에 사용할 수 없지만 적절한 권한을 가진 운영자가 토큰을 조회·폐기하는 식별자로 사용할 수 있습니다. 전체 accessor 목록 권한은 제공하지 않습니다.",
    command: `rm -f /tmp/revoked-token /tmp/revoked-accessor /tmp/revoked-proof.json; umask 077; TOKEN_JSON=$(vault write -format=json auth/token/create/app-read-role policies=app-read ttl=5m) && printf '%s' "$TOKEN_JSON" | jq -er '.auth.client_token' > /tmp/revoked-token && printf '%s' "$TOKEN_JSON" | jq -er '.auth.accessor' > /tmp/revoked-accessor && vault token revoke -accessor "$(cat /tmp/revoked-accessor)" >/dev/null && if vault token lookup "$(cat /tmp/revoked-token)" >/dev/null 2>&1; then exit 1; else printf '%s\\n' '{"method":"accessor","revoked":true}' > /tmp/revoked-proof.json; fi`,
    expected: "accessor revoke 성공 · token lookup 실패 · 구조화된 revoked proof",
    hint: "accessor는 token ID와 다르며 -accessor 플래그를 반드시 사용합니다.",
    troubleshooting: ["lookup이 성공하면 revoke에 token ID와 accessor를 혼동하지 않았는지 확인하세요.", "이전 proof 파일은 명령 시작 시 제거됩니다."],
    success: "accessor를 이용해 토큰과 연결된 권한을 즉시 폐기했습니다.",
    validate: verify("revoke-drill", `
jq -e '. == {"method":"accessor","revoked":true}' /tmp/revoked-proof.json >/dev/null
TOKEN=$(cat /tmp/revoked-token)
ACCESSOR=$(cat /tmp/revoked-accessor)
if vault token lookup "$TOKEN" >/dev/null 2>&1; then exit 1; fi
if vault token lookup -accessor "$ACCESSOR" >/dev/null 2>&1; then exit 1; fi
`),
    expect: [marker("revoke-drill")],
    skipSetup: fixture(`
${ensurePolicy}
umask 077
TOKEN_JSON=$(vault write -format=json auth/token/create/app-read-role policies=app-read ttl=2m)
printf '%s' "$TOKEN_JSON" | jq -er '.auth.client_token' > /tmp/revoked-token
printf '%s' "$TOKEN_JSON" | jq -er '.auth.accessor' > /tmp/revoked-accessor
vault token revoke -accessor "$(cat /tmp/revoked-accessor)" >/dev/null
printf '%s\\n' '{"method":"accessor","revoked":true}' > /tmp/revoked-proof.json
`)
  },
  {
    id: "pki-enable",
    lab: 7,
    title: "PKI Engine과 수명 제한",
    objective: "PKI engine을 idempotent하게 만들고 mount 최대 TTL을 제한합니다.",
    description: "pki/ 엔진을 활성화하고 max_lease_ttl을 1년으로 설정하세요.",
    concept: "mount max_lease_ttl은 이 엔진이 발급할 수 있는 인증서 수명의 상한입니다. Root CA 수명과 leaf 인증서 수명은 별도로 제한합니다.",
    command: `vault secrets list -format=json | jq -e '.[\"pki/\"].type == "pki"' >/dev/null 2>&1 || vault secrets enable pki; vault secrets tune -max-lease-ttl=8760h pki`,
    expected: "pki/ type pki · max_lease_ttl 31536000",
    hint: "engine이 이미 있어도 tune은 항상 실행해 정확한 상한을 적용합니다.",
    troubleshooting: ["path is already in use면 기존 engine type을 확인하세요.", "tune 권한에는 sys/mounts/pki/tune update가 필요합니다."],
    success: "PKI mount의 최대 TTL이 정확히 1년으로 제한되었습니다.",
    validate: verify("pki-enable", `
vault secrets list -format=json |
  jq -e '.[\"pki/\"].type == "pki"' >/dev/null
vault read -format=json sys/mounts/pki/tune |
  jq -e '.data.max_lease_ttl == 31536000' >/dev/null
`),
    expect: [marker("pki-enable")],
    skipSetup: fixture(ensurePki)
  },
  {
    id: "pki-root",
    lab: 7,
    title: "내부 Root CA 생성",
    objective: "명시적인 issuer 이름과 RSA 2048 키로 내부 CA를 생성합니다.",
    description: "example.internal용 1년 수명의 lab-root issuer를 생성하세요.",
    concept: "internal 모드는 CA 개인키를 Vault 밖으로 내보내지 않습니다. 운영에서는 Root CA를 오프라인으로 두고 Vault에는 짧은 수명의 Intermediate CA를 연결하는 구성이 일반적입니다.",
    command: `vault read pki/issuer/lab-root >/dev/null 2>&1 || vault write pki/root/generate/internal issuer_name=lab-root common_name="example.internal" key_type=rsa key_bits=2048 ttl=8760h`,
    expected: "issuer_name lab-root · CA:TRUE · subject CN=example.internal · RSA 2048",
    hint: "AIA/CRL URL 미설정 경고는 이 격리된 실습에서는 예상되며 운영에서는 반드시 구성합니다.",
    troubleshooting: ["requested TTL 초과 오류가 나면 mount max TTL을 확인하세요.", "issuer 이름이 이미 있으면 기존 CA를 재사용합니다."],
    success: "개인키를 외부에 노출하지 않는 명명된 내부 Root CA가 생성되었습니다.",
    validate: verify("pki-root", `
CERT=$(vault read -format=table -field=certificate pki/issuer/lab-root)
printf '%s\\n' "$CERT" | openssl x509 -noout -subject -nameopt RFC2253 |
  grep -qx 'subject=CN=example.internal'
printf '%s\\n' "$CERT" | openssl x509 -noout -text |
  grep -q 'CA:TRUE'
[ "$(printf '%s\\n' "$CERT" | openssl x509 -noout -text | sed -n 's/.*Public-Key: (\\([0-9][0-9]*\\) bit).*/\\1/p' | head -n 1)" = "2048" ]
vault read -format=json pki/issuer/lab-root |
  jq -e '.data.issuer_name == "lab-root" and .data.key_id != ""' >/dev/null
`),
    expect: [marker("pki-root")],
    skipSetup: fixture(ensurePkiRoot)
  },
  {
    id: "pki-role",
    lab: 7,
    title: "서비스 인증서 Role 설계",
    objective: "서브도메인만 허용하고 wildcard·IP·localhost SAN을 차단합니다.",
    description: "lab-root issuer로 example.internal 서브도메인만 최대 1시간 발급하도록 역할을 구성하세요.",
    concept: "PKI Role의 일부 기본값은 wildcard, IP SAN, localhost를 허용합니다. 보안 경계는 의도한 false 값을 명시하고 검증해야 합니다.",
    command: `vault write pki/roles/internal-services issuer_ref=lab-root allowed_domains="example.internal" allow_subdomains=true allow_bare_domains=false allow_glob_domains=false allow_wildcard_certificates=false allow_ip_sans=false allow_localhost=false key_type=rsa key_bits=2048 max_ttl=1h`,
    expected: "서브도메인 true · bare/glob/wildcard/IP/localhost false · max_ttl 3600",
    hint: "allow_subdomains=true 하나만으로는 wildcard와 IP SAN이 차단되지 않습니다.",
    troubleshooting: ["role 이름과 pki/ mount 경로를 확인하세요.", "issuer_ref가 lab-root인지 확인하세요."],
    success: "의도한 DNS 서브도메인만 허용하는 PKI Role이 준비되었습니다.",
    validate: verify("pki-role", `
vault read -format=json pki/roles/internal-services |
  jq -e '.data.issuer_ref == "lab-root" and .data.allowed_domains == ["example.internal"] and .data.allow_subdomains == true and .data.allow_bare_domains == false and .data.allow_glob_domains == false and .data.allow_wildcard_certificates == false and .data.allow_ip_sans == false and .data.allow_localhost == false and .data.key_type == "rsa" and .data.key_bits == 2048 and .data.max_ttl == 3600' >/dev/null
`),
    expect: [marker("pki-role")],
    skipSetup: fixture(ensurePkiRole)
  },
  {
    id: "pki-issue",
    lab: 7,
    title: "단기 인증서 발급과 암호학적 검증",
    objective: "인증서의 subject, SAN, 수명, 체인, private key 일치를 실제 도구로 검증합니다.",
    description: "api.example.internal용 30분 인증서를 mode 0600 JSON 파일로 발급하세요.",
    concept: "PKI issue JSON에는 CN이 별도 평문 필드로 보장되지 않습니다. PEM을 openssl로 해석하고 certificate/public key와 private key가 실제로 일치하는지 확인해야 합니다.",
    command: `umask 077; vault write -format=json pki/issue/internal-services common_name="api.example.internal" ttl=30m > /tmp/api-cert.json`,
    expected: "CN/SAN api.example.internal · 약 30분 · RSA key match · lab-root chain OK",
    hint: "검증기는 JSON 문자열 grep이 아니라 jq로 PEM을 추출해 openssl로 검사합니다.",
    troubleshooting: ["common name not allowed면 role의 allowed_domains와 allow_subdomains를 확인하세요.", "openssl 검증 실패 시 certificate와 private_key가 같은 응답에서 왔는지 확인하세요."],
    success: "subject, SAN, 수명, 체인, private key가 모두 일치하는 단기 인증서입니다.",
    validate: verify("pki-issue", `
test -s /tmp/api-cert.json
[ "$(stat -c %a /tmp/api-cert.json)" = "600" ]
jq -e '.data.certificate | type == "string" and startswith("-----BEGIN CERTIFICATE-----")' /tmp/api-cert.json >/dev/null
jq -e '.data.private_key | type == "string" and contains("BEGIN RSA PRIVATE KEY")' /tmp/api-cert.json >/dev/null
jq -e '.data.private_key_type == "rsa" and (.data.serial_number | type == "string" and length > 0)' /tmp/api-cert.json >/dev/null
CERT_FILE=$(mktemp /tmp/pki-cert.XXXXXX)
KEY_FILE=$(mktemp /tmp/pki-key.XXXXXX)
CA_FILE=$(mktemp /tmp/pki-ca.XXXXXX)
trap 'rm -f "$CERT_FILE" "$KEY_FILE" "$CA_FILE"' EXIT
jq -er '.data.certificate' /tmp/api-cert.json > "$CERT_FILE"
jq -er '.data.private_key' /tmp/api-cert.json > "$KEY_FILE"
vault read -format=table -field=certificate pki/issuer/lab-root > "$CA_FILE"
openssl x509 -in "$CERT_FILE" -noout -subject -nameopt RFC2253 |
  grep -qx 'subject=CN=api.example.internal'
openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName |
  grep -q 'DNS:api.example.internal'
CERT_KEY=$(openssl x509 -in "$CERT_FILE" -pubkey -noout |
  openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
PRIVATE_KEY=$(openssl pkey -in "$KEY_FILE" -pubout -outform DER 2>/dev/null |
  sha256sum | cut -d' ' -f1)
[ "$CERT_KEY" = "$PRIVATE_KEY" ]
openssl verify -CAfile "$CA_FILE" "$CERT_FILE" >/dev/null
NOT_BEFORE=$(date -d "$(openssl x509 -in "$CERT_FILE" -noout -startdate | cut -d= -f2-)" +%s)
NOT_AFTER=$(date -d "$(openssl x509 -in "$CERT_FILE" -noout -enddate | cut -d= -f2-)" +%s)
DURATION=$((NOT_AFTER - NOT_BEFORE))
[ "$DURATION" -ge 1740 ]
[ "$DURATION" -le 1920 ]
`),
    expect: [marker("pki-issue")],
    skipSetup: fixture(issueCertificate)
  }
];
