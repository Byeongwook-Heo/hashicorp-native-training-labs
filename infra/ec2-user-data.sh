#!/usr/bin/env bash
set -euo pipefail

umask 0077

readonly APP_ROOT="/opt/vault-lab"
readonly DEPLOY_DIR="/etc/vault-lab/deploy"
readonly DEPLOY_KEY="${DEPLOY_DIR}/github_ed25519"
readonly DEPLOY_KEY_CANDIDATE="${DEPLOY_DIR}/.github_ed25519.candidate"
readonly DEPLOY_KEY_PUBLIC_CANDIDATE="${DEPLOY_DIR}/.github_ed25519.pub.candidate"
readonly PARAMETER_RESPONSE="${DEPLOY_DIR}/.parameter-response.json"
readonly KNOWN_HOSTS="${DEPLOY_DIR}/github_known_hosts"
readonly EXPECTED_GITHUB_ED25519_FINGERPRINT="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

dnf update -y
dnf install -y \
  amazon-ssm-agent \
  awscli-2 \
  curl-minimal \
  git \
  jq \
  openssl \
  openssh-clients \
  policycoreutils \
  tar \
  unzip
systemctl enable --now amazon-ssm-agent
systemctl disable --now sshd.service >/dev/null 2>&1 || true

install -d -o root -g root -m 0755 \
  "$APP_ROOT" \
  "${APP_ROOT}/releases" \
  /etc/vault-lab
install -d -o root -g root -m 0700 "$DEPLOY_DIR"
install -d -o root -g root -m 0750 /var/lib/vault-lab

cleanup_sensitive_bootstrap_files() {
  rm -f \
    "$DEPLOY_KEY_CANDIDATE" \
    "$DEPLOY_KEY_PUBLIC_CANDIDATE" \
    "$PARAMETER_RESPONSE"
}
trap cleanup_sensitive_bootstrap_files EXIT

metadata_token="$(
  curl -fsS \
    -X PUT \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' \
    http://169.254.169.254/latest/api/token
)"
aws_region="$(
  curl -fsS \
    -H "X-aws-ec2-metadata-token: ${metadata_token}" \
    http://169.254.169.254/latest/meta-data/placement/region
)"
[[ "$aws_region" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || {
  echo "IMDS에서 AWS region을 확인하지 못했습니다." >&2
  exit 1
}

deploy_key_parameter=""
for _attempt in {1..24}; do
  if deploy_key_parameter="$(
    curl -fsS \
      -H "X-aws-ec2-metadata-token: ${metadata_token}" \
      http://169.254.169.254/latest/meta-data/tags/instance/VaultLabDeployKeyParameter
  )" \
    && [[ "$deploy_key_parameter" =~ ^/[A-Za-z0-9_.@/-]+$ ]]; then
    break
  fi
  deploy_key_parameter=""
  sleep 5
done
[[ "$deploy_key_parameter" =~ ^/[A-Za-z0-9_.@/-]+$ ]] || {
  echo "VaultLabDeployKeyParameter tag가 없거나 올바르지 않습니다." >&2
  exit 1
}

deploy_key_downloaded=false
install -o root -g root -m 0600 /dev/null "$PARAMETER_RESPONSE"
for _attempt in {1..60}; do
  if aws ssm get-parameter \
    --region "$aws_region" \
    --name "$deploy_key_parameter" \
    --with-decryption \
    --output json \
      >"$PARAMETER_RESPONSE"; then
    chmod 0600 "$PARAMETER_RESPONSE"
    if jq -er '.Parameter.Value | select(type == "string" and length > 0)' \
      "$PARAMETER_RESPONSE" >"$DEPLOY_KEY_CANDIDATE"; then
      chmod 0600 "$DEPLOY_KEY_CANDIDATE"
      if ssh-keygen -y -f "$DEPLOY_KEY_CANDIDATE" \
        >"$DEPLOY_KEY_PUBLIC_CANDIDATE"; then
        deploy_key_downloaded=true
        break
      fi
    fi
  fi
  for sensitive_file in \
    "$PARAMETER_RESPONSE" \
    "$DEPLOY_KEY_CANDIDATE" \
    "$DEPLOY_KEY_PUBLIC_CANDIDATE"; do
    install -o root -g root -m 0600 /dev/null "$sensitive_file"
  done
  sleep 5
done
if [[ "$deploy_key_downloaded" != "true" ]]; then
  echo "임시 SSM SecureString에서 GitHub Deploy Key를 가져오지 못했습니다." >&2
  exit 1
fi
rm -f "$PARAMETER_RESPONSE"
mv -f "$DEPLOY_KEY_CANDIDATE" "$DEPLOY_KEY"
mv -f "$DEPLOY_KEY_PUBLIC_CANDIDATE" "${DEPLOY_KEY}.pub"
chown root:root "$DEPLOY_KEY"
chmod 0600 "$DEPLOY_KEY"
chown root:root "${DEPLOY_KEY}.pub"
chmod 0644 "${DEPLOY_KEY}.pub"

# Published by GitHub at:
# https://docs.github.com/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
cat >"$KNOWN_HOSTS" <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
EOF
chmod 0644 "$KNOWN_HOSTS"
github_fingerprint="$(
  ssh-keygen -lf "$KNOWN_HOSTS" -E sha256 \
    | awk 'NR == 1 { print $2 }'
)"
if [[ "$github_fingerprint" != "$EXPECTED_GITHUB_ED25519_FINGERPRINT" ]]; then
  echo "GitHub known_hosts fingerprint 검증에 실패했습니다." >&2
  exit 1
fi

cat >/usr/local/bin/vault-lab-git-ssh <<EOF
#!/usr/bin/env bash
exec /usr/bin/ssh \\
  -i ${DEPLOY_KEY} \\
  -o IdentitiesOnly=yes \\
  -o StrictHostKeyChecking=yes \\
  -o UserKnownHostsFile=${KNOWN_HOSTS} \\
  "\$@"
EOF
chown root:root /usr/local/bin/vault-lab-git-ssh
chmod 0755 /usr/local/bin/vault-lab-git-ssh

install -o root -g root -m 0644 \
  "${DEPLOY_KEY}.pub" \
  /var/lib/vault-lab/deploy-key.pub

cat >/etc/motd.d/vault-lab <<'MOTD'
Vault Lab blue/green EC2 후보가 준비되었습니다.

자동 배포는 /var/lib/vault-lab/deploy-key.pub에 대응하는 read-only GitHub
Deploy Key를 이미 등록합니다. 수동 설치 시에는
GIT_SSH_COMMAND=/usr/local/bin/vault-lab-git-ssh 로 저장소를
/opt/vault-lab/repository에 clone한 뒤 infra/install-application.sh를 실행하세요.

활성 release는 /opt/vault-lab/current symlink로 원자 전환됩니다.
MOTD
chmod 0644 /etc/motd.d/vault-lab

restorecon -RF \
  "$DEPLOY_DIR" \
  /usr/local/bin/vault-lab-git-ssh \
  /var/lib/vault-lab 2>/dev/null || true
touch /var/lib/vault-lab/cloud-init-ready
chmod 0644 /var/lib/vault-lab/cloud-init-ready
