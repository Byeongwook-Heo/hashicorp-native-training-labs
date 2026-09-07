#!/usr/bin/env bash
set -Eeuo pipefail

umask 0077
export LC_ALL=C
export LANG=C.UTF-8

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly NATIVE_DIR="${SCRIPT_DIR}/terraform-native"
: "${NATIVE_SLOT_COUNT:=4}"
readonly TERRAFORM_VERSION=1.15.8
readonly SLOT_FILESYSTEM_MIB=1024
readonly SLOT_FILESYSTEM_INODES=16384
readonly SLOT_IMAGE_BYTES="$((SLOT_FILESYSTEM_MIB * 1024 * 1024))"
readonly HOST_FREE_RESERVE_BYTES=2147483648
readonly APP_ROOT=/opt/terraform-lab
readonly MIRROR_ROOT="${APP_ROOT}/providers"
readonly AGENT_SKILLS_ROOT="${APP_ROOT}/agent-skills"
readonly AGENT_SKILLS_REPOSITORY=https://github.com/hashicorp/agent-skills.git
readonly AGENT_SKILLS_COMMIT=4451ceca5456e79cc776efee96a744f7ac96e5bf
readonly AGENT_SKILLS_COUNT=16
readonly IMAGE_ROOT=/var/lib/terraform-lab/images
readonly STATE_ROOT=/var/lib/terraform-lab/sessions
readonly RUNTIME_ROOT=/run/terraform-lab/slots
readonly CONFIG_ROOT=/etc/terraform-lab
readonly TERRAFORM_CONFIG="${CONFIG_ROOT}/terraform.rc"
readonly PROVIDER_MANIFEST="${MIRROR_ROOT}/manifest.sha256"
readonly TMPFILES_CONFIG=/etc/tmpfiles.d/terraform-lab.conf
readonly HASHICORP_RELEASE_KEY_SHA256=c2f5bc1163bd8d15a711616b587bcede212d045a5b8b52df01c74095897cd065

readonly -a PROVIDERS=(
  'local:2.5.3'
  'random:3.7.2'
  'null:3.2.4'
  'tls:4.1.0'
)

readonly -a AGENT_SKILLS_REQUIRED=(
  azure-verified-modules
  new-terraform-provider
  provider-actions
  provider-configuration
  provider-docs
  provider-ephemeral-resources
  provider-framework-migration
  provider-resources
  provider-test-patterns
  refactor-module
  run-acceptance-tests
  terraform-policy
  terraform-search-import
  terraform-stacks
  terraform-style-guide
  terraform-test
)

if (( EUID != 0 )); then
  echo "terraform-native-install.sh must run as root." >&2
  exit 1
fi
if [[ ! "$NATIVE_SLOT_COUNT" =~ ^[0-9]+$ ]] \
  || (( 10#$NATIVE_SLOT_COUNT < 1 || 10#$NATIVE_SLOT_COUNT > 20 )); then
  echo "NATIVE_SLOT_COUNT must be an integer from 1 to 20." >&2
  exit 1
fi

# shellcheck source=/dev/null
source /etc/os-release
if [[ "${ID:-}" != amzn || "${VERSION_ID:-}" != 2023 ]]; then
  echo "Terraform native runtime requires Amazon Linux 2023." >&2
  exit 1
fi
if [[ "$(uname -m)" != x86_64 ]]; then
  echo "Terraform native runtime requires x86_64." >&2
  exit 1
fi
docker_runtime_found=false
command -v docker >/dev/null 2>&1 && docker_runtime_found=true
command -v containerd >/dev/null 2>&1 && docker_runtime_found=true
for forbidden_package in docker docker-ce containerd containerd.io; do
  rpm -q "$forbidden_package" >/dev/null 2>&1 && docker_runtime_found=true
done
if [[ "$docker_runtime_found" == true ]]; then
  echo "Docker/containerd is not permitted on the native Terraform Lab host." >&2
  exit 1
fi
if [[ -e "${APP_ROOT}/current" || -L "${APP_ROOT}/current" ]]; then
  echo "활성 Terraform Lab은 in-place로 재설치하지 않습니다. 새 승인 AMI 후보에 blue/green 배포하세요." >&2
  exit 1
fi

for required_file in \
  CONTROL_ABI \
  terraform-lab-control \
  terraform-lab-shell \
  terraform-lab-exec \
  terraform-lab-reaper \
  terraform-lab-reaper.service \
  terraform-lab-reaper.timer; do
  [[ -f "${NATIVE_DIR}/${required_file}" ]] || {
    echo "Missing Terraform native asset: ${required_file}" >&2
    exit 1
  }
done
native_control_abi="$(tr -d '\n' <"${NATIVE_DIR}/CONTROL_ABI")"
[[ "$native_control_abi" =~ ^[1-9][0-9]*$ ]] || {
  echo "Invalid Terraform native control ABI." >&2
  exit 1
}
readonly native_control_abi

dnf install -y \
  ca-certificates \
  curl-minimal \
  dnf-plugins-core \
  e2fsprogs \
  file \
  findutils \
  git \
  gnupg2-minimal \
  jq \
  openssl \
  policycoreutils \
  procps-ng \
  shadow-utils \
  sudo \
  unzip \
  util-linux

# AL2023 ships gnupg2-minimal by default. HashiCorp's detached-signature
# workflow imports a temporary public key and therefore needs gpg-agent.
if rpm -q gnupg2-minimal >/dev/null 2>&1; then
  dnf swap -y gnupg2-minimal gnupg2-full
elif ! rpm -q gnupg2-full >/dev/null 2>&1; then
  dnf install -y gnupg2-full
fi
if ! command -v gpg >/dev/null || ! command -v gpg-agent >/dev/null; then
  echo "gnupg2-full did not provide the required signature verification tools." >&2
  exit 1
fi

if [[ ! -f /etc/yum.repos.d/hashicorp.repo ]]; then
  dnf config-manager --add-repo \
    https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo
fi
rpm --import https://rpm.releases.hashicorp.com/gpg
dnf install -y "terraform-${TERRAFORM_VERSION}"
terraform_binary=/usr/bin/terraform
[[ -x "$terraform_binary" ]] || {
  echo "Terraform package did not install an executable." >&2
  exit 1
}
[[ "$(rpm -qf --queryformat '%{NAME}' "$terraform_binary")" == "terraform" ]] || {
  echo "Terraform RPM 소유권을 확인하지 못했습니다." >&2
  exit 1
}
installed_version="$($terraform_binary version -json | jq -er '.terraform_version')"
[[ "$installed_version" == "$TERRAFORM_VERSION" ]] || {
  echo "Terraform ${TERRAFORM_VERSION} is required; found ${installed_version}." >&2
  exit 1
}
install -o root -g root -m 0755 "$terraform_binary" /usr/local/bin/terraform
[[ "$(/usr/local/bin/terraform version -json | jq -er '.terraform_version')" \
  == "$TERRAFORM_VERSION" ]]

# Stop every consumer before replacing the provider trust root or slot layout.
systemctl stop terraform-lab-web.service >/dev/null 2>&1 || true
systemctl stop terraform-lab-reaper.timer terraform-lab-reaper.service \
  >/dev/null 2>&1 || true
while IFS= read -r native_unit; do
  [[ "$native_unit" =~ ^terraform-lab-(terminal|command)-s[0-9]{2}-[a-f0-9]{12}\.service$ ]] \
    || continue
  systemctl stop "$native_unit" >/dev/null 2>&1 || true
done < <(
  systemctl list-units --all --full --plain --no-legend \
    'terraform-lab-terminal-*.service' \
    'terraform-lab-command-*.service' | awk '{print $1}'
)

download_root="$(mktemp -d /var/tmp/terraform-provider-mirror.XXXXXX)"
cleanup_downloads() {
  find "$download_root" -xdev -mindepth 1 -delete 2>/dev/null || true
  rmdir "$download_root" 2>/dev/null || true
}
trap cleanup_downloads EXIT

candidate_mirror="${download_root}/mirror"
install -d -o root -g root -m 0700 "$candidate_mirror"
release_key="${download_root}/hashicorp-release-key.asc"
gpg_home="${download_root}/gnupg"
install -d -o root -g root -m 0700 "$gpg_home"
curl --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 \
  --output "$release_key" \
  https://www.hashicorp.com/.well-known/pgp-key.txt
printf '%s  %s\n' "$HASHICORP_RELEASE_KEY_SHA256" "$release_key" \
  | sha256sum -c -
gpg --batch --homedir "$gpg_home" --import "$release_key" >/dev/null

download_provider() {
  local provider="$1"
  local version="$2"
  local release="terraform-provider-${provider}"
  local archive="${release}_${version}_linux_amd64.zip"
  local base_url="https://releases.hashicorp.com/${release}/${version}"
  local archive_path="${download_root}/${archive}"
  local sums_path="${download_root}/${release}_${version}_SHA256SUMS"
  local signature_path="${sums_path}.sig"
  local checksum_line entry provider_entry="" provider_entry_count=0
  local destination binary_destination

  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    --output "$archive_path" "${base_url}/${archive}"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    --output "$sums_path" "${base_url}/${release}_${version}_SHA256SUMS"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    --output "$signature_path" \
    "${base_url}/${release}_${version}_SHA256SUMS.sig"
  [[ -f "$archive_path" && ! -L "$archive_path" \
    && -f "$sums_path" && ! -L "$sums_path" \
    && -f "$signature_path" && ! -L "$signature_path" ]] \
    || { echo "Provider download produced unsafe files: ${provider}" >&2; exit 1; }
  gpg --batch --homedir "$gpg_home" \
    --verify "$signature_path" "$sums_path" >/dev/null
  checksum_line="$(awk -v archive="$archive" '$2 == archive {print}' "$sums_path")"
  [[ "$(printf '%s\n' "$checksum_line" | wc -l)" == 1 \
    && "$checksum_line" =~ ^[a-f0-9]{64}[[:space:]]+${archive}$ ]] || {
    echo "Provider checksum manifest is invalid: ${provider} ${version}" >&2
    exit 1
  }
  (cd "$download_root" && printf '%s\n' "$checksum_line" | sha256sum -c -)

  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    case "$entry" in
      /*|*..*|*\\*)
        echo "Unsafe provider archive entry: ${entry}" >&2
        exit 1
        ;;
    esac
    case "$entry" in
      "terraform-provider-${provider}_v${version}_x"[0-9]*)
        [[ "$entry" != */* ]] || exit 1
        provider_entry="$entry"
        provider_entry_count=$((provider_entry_count + 1))
        ;;
      LICENSE.txt) ;;
      *)
        echo "Unexpected provider archive entry: ${entry}" >&2
        exit 1
        ;;
    esac
  done < <(unzip -Z1 "$archive_path")
  [[ "$provider_entry_count" == 1 ]] || {
    echo "Provider archive must contain exactly one binary: ${provider}" >&2
    exit 1
  }

  destination="${candidate_mirror}/registry.terraform.io/hashicorp/${provider}/${version}/linux_amd64"
  install -d -o root -g root -m 0700 "$destination"
  binary_destination="${destination}/${provider_entry}"
  unzip -p "$archive_path" "$provider_entry" >"${binary_destination}.candidate"
  [[ -s "${binary_destination}.candidate" && ! -L "${binary_destination}.candidate" ]] \
    || { echo "Provider extraction failed: ${provider}" >&2; exit 1; }
  chmod 0555 "${binary_destination}.candidate"
  chown root:root "${binary_destination}.candidate"
  mv -fT "${binary_destination}.candidate" "$binary_destination"
  file --brief "$binary_destination" \
    | grep -Eq '^ELF 64-bit LSB (pie )?executable, x86-64,' || {
    echo "Extracted provider is not a Linux x86_64 ELF binary: ${provider}" >&2
    exit 1
  }
}

for provider_spec in "${PROVIDERS[@]}"; do
  download_provider "${provider_spec%%:*}" "${provider_spec#*:}"
done

find "$candidate_mirror" -type d -exec chmod 0555 {} +
find "$candidate_mirror" -type f -exec chown root:root {} +
find "$candidate_mirror" -type f -exec chmod 0555 {} +
chown -R root:root "$candidate_mirror"

install -d -o root -g root -m 0755 "$APP_ROOT" "$CONFIG_ROOT"
if [[ -e "$MIRROR_ROOT" || -L "$MIRROR_ROOT" ]]; then
  [[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] || {
    echo "Existing provider mirror path is unsafe." >&2
    exit 1
  }
  find "$MIRROR_ROOT" -xdev -mindepth 1 -delete
  rmdir "$MIRROR_ROOT"
fi
mv -T "$candidate_mirror" "$MIRROR_ROOT"
chown -R root:root "$MIRROR_ROOT"
find "$MIRROR_ROOT" -type d -exec chmod 0555 {} +
find "$MIRROR_ROOT" -type f -exec chmod 0555 {} +

cat >"${TERRAFORM_CONFIG}.candidate" <<'EOF'
disable_checkpoint = true

provider_installation {
  filesystem_mirror {
    path = "/opt/terraform-lab/providers"
    include = [
      "registry.terraform.io/hashicorp/local",
      "registry.terraform.io/hashicorp/random",
      "registry.terraform.io/hashicorp/null",
      "registry.terraform.io/hashicorp/tls",
    ]
  }
}
EOF
chown root:root "${TERRAFORM_CONFIG}.candidate"
chmod 0444 "${TERRAFORM_CONFIG}.candidate"
mv -fT "${TERRAFORM_CONFIG}.candidate" "$TERRAFORM_CONFIG"

manifest_candidate="${download_root}/provider-manifest.sha256"
(
  cd "$MIRROR_ROOT"
  find . -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) >"$manifest_candidate"
[[ "$(wc -l <"$manifest_candidate")" == "${#PROVIDERS[@]}" ]] || {
  echo "Provider mirror manifest does not cover exactly four binaries." >&2
  exit 1
}
chmod 0755 "$MIRROR_ROOT"
install -o root -g root -m 0444 "$manifest_candidate" "$PROVIDER_MANIFEST"
chmod 0555 "$MIRROR_ROOT"
(cd "$MIRROR_ROOT" && sha256sum -c "$PROVIDER_MANIFEST")

# Agent Skills are fetched only while building the immutable host. Learner
# scopes have IPAddressDeny=any and consume this root-owned snapshot offline.
agent_skills_checkout="${download_root}/agent-skills-checkout"
agent_skills_candidate="${download_root}/agent-skills"
git init --quiet --initial-branch=main "$agent_skills_checkout"
git -C "$agent_skills_checkout" remote add origin "$AGENT_SKILLS_REPOSITORY"
GIT_TERMINAL_PROMPT=0 git -C "$agent_skills_checkout" \
  fetch --quiet --depth=1 origin "$AGENT_SKILLS_COMMIT"
git -C "$agent_skills_checkout" checkout --quiet --detach FETCH_HEAD
[[ "$(git -C "$agent_skills_checkout" rev-parse HEAD)" \
  == "$AGENT_SKILLS_COMMIT" ]] || {
  echo "HashiCorp Agent Skills commit 검증에 실패했습니다." >&2
  exit 1
}

agent_skills_source="${agent_skills_checkout}/plugins/terraform/skills"
[[ -d "$agent_skills_source" && ! -L "$agent_skills_source" ]] || {
  echo "HashiCorp Terraform Agent Skills 경로가 안전하지 않습니다." >&2
  exit 1
}
if find "${agent_skills_checkout}/plugins" \
  "${agent_skills_checkout}/.agents/plugins" \
  -type l -print -quit | grep -q .; then
  echo "HashiCorp Agent Skills plugin snapshot에 symlink가 포함되어 있습니다." >&2
  exit 1
fi
agent_skills_count="$(
  find "$agent_skills_source" -mindepth 1 -maxdepth 1 -type d | wc -l
)"
agent_skills_count="${agent_skills_count//[[:space:]]/}"
[[ "$agent_skills_count" == "$AGENT_SKILLS_COUNT" ]] || {
  echo "HashiCorp Terraform Agent Skill 수가 예상과 다릅니다." >&2
  exit 1
}
for agent_skill in "${AGENT_SKILLS_REQUIRED[@]}"; do
  skill_file="${agent_skills_source}/${agent_skill}/SKILL.md"
  [[ -f "$skill_file" && ! -L "$skill_file" ]] || {
    echo "필수 HashiCorp Agent Skill이 없습니다: ${agent_skill}" >&2
    exit 1
  }
  grep -Fqx "name: ${agent_skill}" "$skill_file" || {
    echo "HashiCorp Agent Skill 이름이 일치하지 않습니다: ${agent_skill}" >&2
    exit 1
  }
  grep -Fq "lifecycle-status: active" "$skill_file" || {
    echo "비활성 HashiCorp Agent Skill을 거부했습니다: ${agent_skill}" >&2
    exit 1
  }
done
grep -Fq "Mozilla Public License Version 2.0" \
  "${agent_skills_checkout}/LICENSE" || {
  echo "HashiCorp Agent Skills MPL-2.0 라이선스를 확인하지 못했습니다." >&2
  exit 1
}

install -d -o root -g root -m 0755 "$agent_skills_candidate"
cp -R -- "${agent_skills_checkout}/plugins" \
  "${agent_skills_candidate}/plugins"
install -d -o root -g root -m 0755 "${agent_skills_candidate}/.agents"
cp -R -- "${agent_skills_checkout}/.agents/plugins" \
  "${agent_skills_candidate}/.agents/plugins"
for agent_skills_metadata in \
  README.md SKILLS.md CHANGELOG.md SUPPORTED_MODELS.md \
  SECURITY.md SUPPORT.md LICENSE; do
  [[ -f "${agent_skills_checkout}/${agent_skills_metadata}" \
    && ! -L "${agent_skills_checkout}/${agent_skills_metadata}" ]] || {
    echo "HashiCorp Agent Skills metadata가 안전하지 않습니다: ${agent_skills_metadata}" >&2
    exit 1
  }
  cp -a -- "${agent_skills_checkout}/${agent_skills_metadata}" \
    "${agent_skills_candidate}/${agent_skills_metadata}"
done
printf '%s\n' "$AGENT_SKILLS_COMMIT" \
  >"${agent_skills_candidate}/.upstream-commit"
(
  cd "$agent_skills_candidate"
  find . -type f ! -path './manifest.sha256' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) >"${agent_skills_candidate}/manifest.sha256"
chown -R root:root "$agent_skills_candidate"
find "$agent_skills_candidate" -type d -exec chmod 0555 {} +
find "$agent_skills_candidate" -type f -exec chmod 0444 {} +
(cd "$agent_skills_candidate" && sha256sum -c manifest.sha256)

if [[ -e "$AGENT_SKILLS_ROOT" || -L "$AGENT_SKILLS_ROOT" ]]; then
  [[ -d "$AGENT_SKILLS_ROOT" && ! -L "$AGENT_SKILLS_ROOT" ]] || {
    echo "기존 Agent Skills 경로가 안전하지 않습니다." >&2
    exit 1
  }
  find "$AGENT_SKILLS_ROOT" -xdev -mindepth 1 -delete
  rmdir "$AGENT_SKILLS_ROOT"
fi
mv -T "$agent_skills_candidate" "$AGENT_SKILLS_ROOT"
[[ "$(stat -c '%u:%g:%a' "$AGENT_SKILLS_ROOT")" == "0:0:555" ]]
(cd "$AGENT_SKILLS_ROOT" && sha256sum -c manifest.sha256)

getent passwd terraform-lab >/dev/null || useradd \
  --system --user-group --home-dir "$APP_ROOT" --shell /sbin/nologin \
  --comment "Terraform Lab web application" terraform-lab
getent passwd terraform-lab-build >/dev/null || useradd \
  --system --user-group --home-dir /var/lib/terraform-lab-build \
  --create-home --shell /sbin/nologin \
  --comment "Terraform Lab release builder" terraform-lab-build

install -d -o root -g root -m 0755 \
  "$APP_ROOT" "$IMAGE_ROOT" "$STATE_ROOT" /var/lib/terraform-lab
chmod 0700 "$IMAGE_ROOT"
install -d -o terraform-lab -g terraform-lab -m 0700 \
  /var/lib/terraform-lab/app /var/lib/terraform-lab/content

for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  slot_user="tflab-${slot}"
  slot_home="${STATE_ROOT}/${slot}/home"
  if ! getent passwd "$slot_user" >/dev/null; then
    useradd --system --user-group --home-dir "$slot_home" \
      --no-create-home --shell /sbin/nologin \
      --comment "Terraform Lab isolated slot ${slot}" "$slot_user"
  fi
  passwd -l "$slot_user" >/dev/null 2>&1 || true
  gpasswd -d terraform-lab "$slot_user" >/dev/null 2>&1 || true
done

missing_images=0
for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  [[ -e "${IMAGE_ROOT}/${slot}.ext4" ]] || missing_images=$((missing_images + 1))
done
available_bytes="$(df -B1 --output=avail "$IMAGE_ROOT" | awk 'NR == 2 {print $1}')"
required_bytes="$((missing_images * SLOT_IMAGE_BYTES + HOST_FREE_RESERVE_BYTES))"
[[ "$available_bytes" =~ ^[0-9]+$ && "$available_bytes" -ge "$required_bytes" ]] || {
  echo "Terraform slot images require ${required_bytes} free bytes." >&2
  exit 1
}

declare -a mount_units=()
for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  image="${IMAGE_ROOT}/${slot}.ext4"
  mountpoint="${STATE_ROOT}/${slot}"
  mount_unit="$(systemd-escape --path --suffix=mount "$mountpoint")"
  mount_units+=("$mount_unit")
  if [[ ! -e "$image" ]]; then
    temporary_image="${IMAGE_ROOT}/.${slot}.ext4.$$"
    fallocate -l "$SLOT_IMAGE_BYTES" "$temporary_image"
    mkfs.ext4 -F -q -L "terraform-${slot}" \
      -N "$SLOT_FILESYSTEM_INODES" -m 0 \
      -E nodiscard,lazy_itable_init=0,lazy_journal_init=0 "$temporary_image"
    chown root:root "$temporary_image"
    chmod 0600 "$temporary_image"
    mv -fT "$temporary_image" "$image"
  fi
  [[ -f "$image" && ! -L "$image" \
    && "$(stat -c '%u:%g:%h:%a:%s' "$image")" \
      == "0:0:1:600:${SLOT_IMAGE_BYTES}" ]] || {
    echo "Terraform slot image metadata is unsafe: ${slot}" >&2
    exit 1
  }
  allocated_bytes="$(( $(stat -c %b "$image") * 512 ))"
  (( allocated_bytes >= SLOT_IMAGE_BYTES )) || {
    echo "Terraform slot image is unexpectedly sparse: ${slot}" >&2
    exit 1
  }
  inode_count="$(tune2fs -l "$image" 2>/dev/null \
    | awk -F: '$1 == "Inode count" {gsub(/[[:space:]]/, "", $2); print $2}')"
  [[ "$inode_count" == "$SLOT_FILESYSTEM_INODES" ]] || {
    echo "Terraform slot inode budget drifted: ${slot}" >&2
    exit 1
  }
  install -d -o root -g root -m 0711 "$mountpoint"
  cat >"/etc/systemd/system/${mount_unit}" <<EOF
[Unit]
Description=Bounded Terraform Lab filesystem ${slot}
Before=terraform-lab-storage.target

[Mount]
What=${image}
Where=${mountpoint}
Type=ext4
Options=loop,nodev,nosuid,noexec
TimeoutSec=30

[Install]
WantedBy=terraform-lab-storage.target
EOF
  chmod 0644 "/etc/systemd/system/${mount_unit}"
done

{
  printf '%s\n' \
    '[Unit]' \
    'Description=Bounded per-slot Terraform Lab filesystems' \
    "Requires=${mount_units[*]}" \
    "After=${mount_units[*]}" \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target'
} >/etc/systemd/system/terraform-lab-storage.target
chmod 0644 /etc/systemd/system/terraform-lab-storage.target

install -o root -g root -m 0755 \
  "${NATIVE_DIR}/terraform-lab-control" /usr/local/sbin/terraform-lab-control
install -o root -g root -m 0755 \
  "${NATIVE_DIR}/terraform-lab-shell" /usr/local/libexec/terraform-lab-shell
install -o root -g root -m 0755 \
  "${NATIVE_DIR}/terraform-lab-exec" /usr/local/libexec/terraform-lab-exec
install -o root -g root -m 0755 \
  "${NATIVE_DIR}/terraform-lab-reaper" /usr/local/sbin/terraform-lab-reaper
install -o root -g root -m 0644 \
  "${NATIVE_DIR}/terraform-lab-reaper.service" \
  /etc/systemd/system/terraform-lab-reaper.service
install -o root -g root -m 0644 \
  "${NATIVE_DIR}/terraform-lab-reaper.timer" \
  /etc/systemd/system/terraform-lab-reaper.timer
install -o root -g root -m 0644 \
  "${SCRIPT_DIR}/systemd/terraform-lab.slice" \
  /etc/systemd/system/terraform-lab.slice
install -o root -g root -m 0644 \
  "${SCRIPT_DIR}/systemd/terraform-lab-web.service" \
  /etc/systemd/system/terraform-lab-web.service
printf '%s\n' "$native_control_abi" >"${CONFIG_ROOT}/native-control-abi"
chown root:root "${CONFIG_ROOT}/native-control-abi"
chmod 0644 "${CONFIG_ROOT}/native-control-abi"

restorecon -RF "$APP_ROOT" "$CONFIG_ROOT" \
  /usr/local/bin/terraform \
  /usr/local/sbin/terraform-lab-control \
  /usr/local/sbin/terraform-lab-reaper \
  /usr/local/libexec/terraform-lab-shell \
  /usr/local/libexec/terraform-lab-exec 2>/dev/null || true

cat >"$TMPFILES_CONFIG" <<'EOF'
d /run/terraform-lab 0711 root root -
d /run/terraform-lab/slots 0711 root root -
d /run/terraform-lab/app 0700 terraform-lab terraform-lab -
d /run/lock/terraform-lab-control 0700 root root -
EOF
for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  printf 'd /run/terraform-lab/slots/%s 2750 terraform-lab tflab-%s -\n' \
    "$slot" "$slot" >>"$TMPFILES_CONFIG"
done
chown root:root "$TMPFILES_CONFIG"
chmod 0644 "$TMPFILES_CONFIG"
cat >/etc/sudoers.d/terraform-lab-native <<'EOF'
Defaults:terraform-lab env_reset
Defaults:terraform-lab secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Defaults:terraform-lab !set_home
terraform-lab ALL=(root) NOPASSWD: /usr/local/sbin/terraform-lab-control *
EOF
chmod 0440 /etc/sudoers.d/terraform-lab-native
visudo -cf /etc/sudoers.d/terraform-lab-native

systemctl daemon-reload
systemd-tmpfiles --create "$TMPFILES_CONFIG"
systemctl enable terraform-lab-storage.target terraform-lab-reaper.timer
systemctl restart terraform-lab-storage.target

for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  slot_user="tflab-${slot}"
  mountpoint="${STATE_ROOT}/${slot}"
  mount_data="$(findmnt -rn -M "$mountpoint" -o TARGET,FSTYPE,OPTIONS)"
  [[ "$mount_data" == "${mountpoint} ext4 "* ]] || exit 1
  for option in rw nodev nosuid noexec; do
    [[ ",${mount_data#* ext4 }," == *",${option},"* ]] || exit 1
  done
  chown root:root "$mountpoint"
  chmod 0711 "$mountpoint"
  printf 'terraform-lab:%s:v1\n' "$slot" >"${mountpoint}/.marker.$$"
  chown root:root "${mountpoint}/.marker.$$"
  chmod 0400 "${mountpoint}/.marker.$$"
  mv -fT "${mountpoint}/.marker.$$" "${mountpoint}/.terraform-lab-slot"
  install -d -o "$slot_user" -g "$slot_user" -m 0700 \
    "${mountpoint}/home" "${mountpoint}/tmp"
  chmod 1700 "${mountpoint}/tmp"
  runtime_dir="${RUNTIME_ROOT}/${slot}"
  install -d -o terraform-lab -g "$slot_user" -m 2750 "$runtime_dir"
  /usr/local/sbin/terraform-lab-control prepare "$slot"
done

systemctl start terraform-lab-reaper.timer

# Prove that Terraform can link trusted unpacked providers from an executable,
# root-owned mirror while the learner workspace itself remains noexec.
smoke_slot=s01
smoke_user=tflab-s01
smoke_home="${STATE_ROOT}/${smoke_slot}/home"
smoke_dir="${smoke_home}/provider-smoke"
install -d -o "$smoke_user" -g "$smoke_user" -m 0700 "$smoke_dir"
cat >"${smoke_dir}/main.tf" <<'EOF'
terraform {
  required_version = "= 1.15.8"
  required_providers {
    local  = { source = "hashicorp/local",  version = "= 2.5.3" }
    random = { source = "hashicorp/random", version = "= 3.7.2" }
    null   = { source = "hashicorp/null",   version = "= 3.2.4" }
    tls    = { source = "hashicorp/tls",    version = "= 4.1.0" }
  }
}

resource "local_file" "proof" {
  filename = "${path.module}/proof.txt"
  content  = random_id.proof.hex
}
resource "random_id" "proof" { byte_length = 4 }
resource "null_resource" "proof" { triggers = { value = random_id.proof.hex } }
resource "tls_private_key" "proof" { algorithm = "ED25519" }
EOF
chown "$smoke_user:$smoke_user" "${smoke_dir}/main.tf"
chmod 0600 "${smoke_dir}/main.tf"
run_as_smoke=(
  runuser -u "$smoke_user" -- env -i
  HOME="$smoke_home"
  PATH=/usr/local/bin:/usr/bin:/bin
  LANG=C.UTF-8
  TF_CLI_CONFIG_FILE="$TERRAFORM_CONFIG"
  TF_DATA_DIR=.terraform
  CHECKPOINT_DISABLE=1
  AWS_EC2_METADATA_DISABLED=true
  TF_INPUT=0
  TF_IN_AUTOMATION=1
)
"${run_as_smoke[@]}" /usr/local/bin/terraform -chdir="$smoke_dir" \
  init -input=false -no-color
for provider_spec in "${PROVIDERS[@]}"; do
  provider="${provider_spec%%:*}"
  version="${provider_spec#*:}"
  installed_path="${smoke_dir}/.terraform/providers/registry.terraform.io/hashicorp/${provider}/${version}/linux_amd64"
  [[ -L "$installed_path" ]] || {
    echo "Terraform did not create an unpacked mirror symlink: ${provider}" >&2
    exit 1
  }
  [[ "$(readlink -f "$installed_path")" \
    == "${MIRROR_ROOT}/registry.terraform.io/hashicorp/${provider}/${version}/linux_amd64" ]] \
    || exit 1
done
"${run_as_smoke[@]}" /usr/local/bin/terraform -chdir="$smoke_dir" \
  plan -input=false -lock=false -no-color -out=smoke.tfplan
"${run_as_smoke[@]}" /usr/local/bin/terraform -chdir="$smoke_dir" \
  show -json smoke.tfplan | jq -e '.format_version and .planned_values' >/dev/null
findmnt -rn -M "${STATE_ROOT}/${smoke_slot}" -o OPTIONS \
  | tr ',' '\n' | grep -Fx noexec >/dev/null
/usr/local/sbin/terraform-lab-control prepare "$smoke_slot"

restorecon -RF "$APP_ROOT" "$CONFIG_ROOT" /var/lib/terraform-lab \
  /usr/local/sbin/terraform-lab-control \
  /usr/local/sbin/terraform-lab-reaper \
  /usr/local/libexec/terraform-lab-shell \
  /usr/local/libexec/terraform-lab-exec 2>/dev/null || true

echo "Terraform ${TERRAFORM_VERSION} native runtime installed."
echo "Provider mirror manifest: ${PROVIDER_MANIFEST}"
echo "Slots: ${NATIVE_SLOT_COUNT} x ${SLOT_FILESYSTEM_MIB}MiB (nodev,nosuid,noexec)"
