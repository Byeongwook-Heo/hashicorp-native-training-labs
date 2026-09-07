#!/usr/bin/env bash
set -euo pipefail

# Amazon Linux 2023 native runtime installer for Vault Lab.
#
# Optional environment:
#   NATIVE_SLOT_COUNT=4        Pre-created isolated session users (1..99)
#   VAULT_VERSION=2.0.3        Pinned RPM version validated by this release
#   SLOT_FILESYSTEM_MIB=512    Preallocated ext4 bytes per slot (256..2048 MiB)
#   SLOT_FILESYSTEM_INODES=4096 Fixed inode budget per slot (2048..65536)
#
# Run from a checked-out Git repository:
#   sudo NATIVE_SLOT_COUNT=4 VAULT_VERSION=2.0.3 ./infra/native-install.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly NATIVE_DIR="${SCRIPT_DIR}/native"
: "${NATIVE_SLOT_COUNT:=4}"
: "${VAULT_VERSION:=2.0.3}"
: "${SLOT_FILESYSTEM_MIB:=512}"
: "${SLOT_FILESYSTEM_INODES:=4096}"
readonly IMAGE_ROOT="/var/lib/vault-lab/images"
readonly STATE_ROOT="/var/lib/vault-lab/sessions"
readonly CONTROL_LOCK_ROOT="/run/lock/vault-lab-control"
readonly NATIVE_SMOKE_PENDING_FILE="/etc/vault-lab/native-smoke-pending"
readonly HOST_FREE_RESERVE_BYTES=2147483648

if (( EUID != 0 )); then
  echo "native-install.sh must run as root." >&2
  exit 1
fi

if [[ ! "$NATIVE_SLOT_COUNT" =~ ^[0-9]+$ ]] \
  || (( 10#$NATIVE_SLOT_COUNT < 1 || 10#$NATIVE_SLOT_COUNT > 99 )); then
  echo "NATIVE_SLOT_COUNT must be an integer from 1 to 99." >&2
  exit 1
fi
if [[ ! "$SLOT_FILESYSTEM_MIB" =~ ^[0-9]+$ ]] \
  || (( 10#$SLOT_FILESYSTEM_MIB < 256 || 10#$SLOT_FILESYSTEM_MIB > 2048 )); then
  echo "SLOT_FILESYSTEM_MIB must be an integer from 256 to 2048." >&2
  exit 1
fi
if [[ ! "$SLOT_FILESYSTEM_INODES" =~ ^[0-9]+$ ]] \
  || (( 10#$SLOT_FILESYSTEM_INODES < 2048 || 10#$SLOT_FILESYSTEM_INODES > 65536 )); then
  echo "SLOT_FILESYSTEM_INODES must be an integer from 2048 to 65536." >&2
  exit 1
fi
readonly SLOT_IMAGE_BYTES="$((10#$SLOT_FILESYSTEM_MIB * 1024 * 1024))"

# shellcheck source=/dev/null
source /etc/os-release
if [[ "${ID:-}" != "amzn" || "${VERSION_ID:-}" != "2023" ]]; then
  echo "This installer supports Amazon Linux 2023 only." >&2
  exit 1
fi

for required_file in \
  CONTROL_ABI \
  vault-lab@.service \
  vault-lab-control \
  vault-lab-shell \
  vault-lab-exec \
  vault-lab-loopback \
  vault-lab-loopback.service \
  vault-lab-reaper \
  vault-lab-reaper.service \
  vault-lab-reaper.timer; do
  [[ -f "${NATIVE_DIR}/${required_file}" ]] || {
    echo "Missing installer asset: ${NATIVE_DIR}/${required_file}" >&2
    exit 1
  }
done
native_control_abi="$(tr -d '\n' <"${NATIVE_DIR}/CONTROL_ABI")"
[[ "$native_control_abi" =~ ^[1-9][0-9]*$ ]] || {
  echo "Unsupported native control ABI in release." >&2
  exit 1
}
readonly native_control_abi

# Stop and disable every boot-time consumer before the first host migration.
# This also protects legacy web releases that do not understand ABI sentinels.
systemctl stop vault-lab-web.service >/dev/null 2>&1 || true
systemctl disable vault-lab-web.service >/dev/null 2>&1 || true
systemctl stop vault-lab-reaper.timer >/dev/null 2>&1 || true
systemctl stop vault-lab-reaper.service >/dev/null 2>&1 || true
systemctl disable vault-lab-reaper.timer >/dev/null 2>&1 || true
systemctl stop vault-lab-loopback.service >/dev/null 2>&1 || true
systemctl disable vault-lab-loopback.service >/dev/null 2>&1 || true
for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  systemctl stop "vault-lab@${slot}.service" >/dev/null 2>&1 || true
  while IFS= read -r scoped_unit; do
    [[ "$scoped_unit" =~ ^vault-lab-(terminal|exec)-${slot}-[a-f0-9]{12}\.service$ ]] \
      || continue
    systemctl stop "$scoped_unit" >/dev/null 2>&1 || true
  done < <(
    systemctl list-units --all --full --plain --no-legend \
      "vault-lab-terminal-${slot}-*.service" \
      "vault-lab-exec-${slot}-*.service" |
      awk '{ print $1 }'
    )
done
sync -f /etc/systemd/system
for native_consumer in \
  vault-lab-web.service \
  vault-lab-reaper.timer \
  vault-lab-reaper.service \
  vault-lab-loopback.service; do
  if systemctl is-active --quiet "$native_consumer"; then
    echo "Cannot stop ${native_consumer} before native migration." >&2
    exit 1
  fi
done
for native_consumer in \
  vault-lab-web.service \
  vault-lab-reaper.timer \
  vault-lab-loopback.service; do
  if systemctl is-enabled --quiet "$native_consumer"; then
    echo "Cannot disable ${native_consumer} before native migration." >&2
    exit 1
  fi
done

# Persist a deliberately incompatible marker before replacing the first native
# helper. A crash or reboot can therefore never advertise a mixed install as
# committed.
install -d -o root -g root -m 0755 /etc/vault-lab
if [[ -e "$NATIVE_SMOKE_PENDING_FILE" || -L "$NATIVE_SMOKE_PENDING_FILE" ]]; then
  if [[ ! -f "$NATIVE_SMOKE_PENDING_FILE" \
    || -L "$NATIVE_SMOKE_PENDING_FILE" ]]; then
    echo "Native smoke pending marker is not a safe regular file." >&2
    exit 1
  fi
  if [[ "$(stat -c '%u:%g:%a' -- "$NATIVE_SMOKE_PENDING_FILE")" \
    != "0:0:600" ]]; then
    echo "Native smoke pending marker metadata is unsafe." >&2
    exit 1
  fi
fi
smoke_pending_temporary="${NATIVE_SMOKE_PENDING_FILE}.native-install.$$"
rm -f -- "$smoke_pending_temporary"
printf 'native-smoke-pending:%s:migration\n' "$native_control_abi" \
  >"$smoke_pending_temporary"
chown root:root "$smoke_pending_temporary"
chmod 0600 "$smoke_pending_temporary"
sync -f "$smoke_pending_temporary"
mv -fT -- "$smoke_pending_temporary" "$NATIVE_SMOKE_PENDING_FILE"
sync -f "$NATIVE_SMOKE_PENDING_FILE"
sync -f /etc/vault-lab
[[ "$(<"$NATIVE_SMOKE_PENDING_FILE")" \
  == "native-smoke-pending:${native_control_abi}:migration" ]]
[[ "$(stat -c '%u:%g:%a' -- "$NATIVE_SMOKE_PENDING_FILE")" \
  == "0:0:600" ]]

abi_sentinel_temporary="/etc/vault-lab/.native-control-abi-updating.$$"
rm -f -- "$abi_sentinel_temporary"
printf 'updating-%s\n' "$native_control_abi" >"$abi_sentinel_temporary"
chown root:root "$abi_sentinel_temporary"
chmod 0644 "$abi_sentinel_temporary"
sync -f "$abi_sentinel_temporary"
mv -fT -- "$abi_sentinel_temporary" /etc/vault-lab/native-control-abi
sync -f /etc/vault-lab/native-control-abi
sync -f /etc/vault-lab

dnf install -y \
  ca-certificates \
  curl-minimal \
  dnf-plugins-core \
  e2fsprogs \
  git \
  iproute \
  procps-ng \
  python3 \
  shadow-utils \
  sudo \
  util-linux

if [[ ! -f /etc/yum.repos.d/hashicorp.repo ]]; then
  dnf config-manager --add-repo \
    https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo
fi
rpm --import https://rpm.releases.hashicorp.com/gpg
if [[ -n "$VAULT_VERSION" ]]; then
  [[ "$VAULT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]] || {
    echo "VAULT_VERSION has an invalid format." >&2
    exit 1
  }
  dnf install -y "vault-${VAULT_VERSION}"
else
  dnf install -y vault
fi

vault_binary="$(command -v vault)"
[[ -x "$vault_binary" ]] || {
  echo "Vault installation did not produce an executable." >&2
  exit 1
}
if [[ "$vault_binary" != "/usr/local/bin/vault" ]]; then
  install -o root -g root -m 0755 "$vault_binary" /usr/local/bin/vault
fi

getent passwd vault-lab >/dev/null || \
  useradd \
    --system \
    --home-dir /opt/vault-lab \
    --shell /sbin/nologin \
    --comment "Vault Lab web application" \
    vault-lab

install -d -o root -g root -m 0755 /opt/vault-lab
install -d -o root -g root -m 0755 /etc/vault-lab
install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0755 /var/lib/vault-lab
install -d -o root -g root -m 0700 "$IMAGE_ROOT"
install -d -o root -g root -m 0755 "$STATE_ROOT"

if [[ -e /run/vault-lab || -L /run/vault-lab ]]; then
  [[ -d /run/vault-lab && ! -L /run/vault-lab ]] || {
    echo "Unsafe /run/vault-lab runtime anchor." >&2
    exit 1
  }
  if mountpoint -q /run/vault-lab; then
    echo "Unexpected mount at /run/vault-lab." >&2
    exit 1
  fi
  chown --no-dereference root:root /run/vault-lab
  chmod 0711 /run/vault-lab
else
  install -d -o root -g root -m 0711 /run/vault-lab
fi
for runtime_child in /run/vault-lab/slots /run/vault-lab/app; do
  if mountpoint -q "$runtime_child"; then
    echo "Unexpected mount at ${runtime_child}." >&2
    exit 1
  fi
  if [[ -e "$runtime_child" || -L "$runtime_child" ]]; then
    rm -rf --one-file-system -- "$runtime_child"
  fi
done
install -d -o root -g root -m 0711 /run/vault-lab/slots
install -d -o root -g root -m 0700 /run/vault-lab/slots/.control
install -d -o vault-lab -g vault-lab -m 0700 /run/vault-lab/app
install -d -o root -g root -m 0700 "$CONTROL_LOCK_ROOT"
install -d -o root -g root -m 0555 /var/empty

for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  slot_user="vaultlab-${slot}"
  verifier_user="vaultverify-${slot}"
  service_user="vaultsvc-${slot}"
  slot_address="127.77.0.${index}"
  slot_state="${STATE_ROOT}/${slot}"
  slot_home="/var/lib/vault-lab/sessions/${slot}/home"
  if ! getent passwd "$slot_user" >/dev/null; then
    useradd \
      --system \
      --user-group \
      --home-dir "$slot_home" \
      --no-create-home \
      --shell /sbin/nologin \
      --comment "Vault Lab isolated slot ${slot}" \
      "$slot_user"
  fi
  passwd -l "$slot_user" >/dev/null 2>&1 || true
  if ! getent passwd "$verifier_user" >/dev/null; then
    useradd \
      --system \
      --gid "$slot_user" \
      --home-dir "$slot_home" \
      --no-create-home \
      --shell /sbin/nologin \
      --comment "Vault Lab trusted verifier ${slot}" \
      "$verifier_user"
  else
    usermod -g "$slot_user" "$verifier_user"
  fi
  passwd -l "$verifier_user" >/dev/null 2>&1 || true
  if ! getent passwd "$service_user" >/dev/null; then
    useradd \
      --system \
      --gid "$slot_user" \
      --home-dir /var/empty \
      --no-create-home \
      --shell /sbin/nologin \
      --comment "Vault Lab service identity ${slot}" \
      "$service_user"
  else
    usermod -g "$slot_user" "$service_user"
  fi
  passwd -l "$service_user" >/dev/null 2>&1 || true
  gpasswd -d vault-lab "$slot_user" >/dev/null 2>&1 || true

  mount_unit="$(systemd-escape --path --suffix=mount "$slot_state")"
  network_dropin="/etc/systemd/system/vault-lab@${slot}.service.d"
  install -d -o root -g root -m 0755 "$network_dropin"
  printf '%s\n' \
    '[Unit]' \
    "Requires=${mount_unit}" \
    "After=${mount_unit}" \
    '' \
    '[Service]' \
    'IPAddressDeny=any' \
    "IPAddressAllow=${slot_address}/32" \
    >"${network_dropin}/20-slot-network.conf"
  chmod 0644 "${network_dropin}/20-slot-network.conf"
done

missing_images=0
for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  [[ -e "${IMAGE_ROOT}/${slot}.ext4" ]] || missing_images=$((missing_images + 1))
done
available_bytes="$(df -B1 --output=avail "$IMAGE_ROOT" | awk 'NR == 2 { print $1 }')"
required_bytes="$((missing_images * SLOT_IMAGE_BYTES + HOST_FREE_RESERVE_BYTES))"
if [[ ! "$available_bytes" =~ ^[0-9]+$ ]] || (( available_bytes < required_bytes )); then
  echo "Slot images require ${required_bytes} free bytes while preserving the host reserve." >&2
  exit 1
fi

declare -a mount_units=()
for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  image="${IMAGE_ROOT}/${slot}.ext4"
  mountpoint="${STATE_ROOT}/${slot}"
  mount_unit="$(systemd-escape --path --suffix=mount "$mountpoint")"
  mount_unit_path="/etc/systemd/system/${mount_unit}"
  mount_units+=("$mount_unit")

  if [[ ! -e "$image" ]]; then
    temporary_image="${IMAGE_ROOT}/.${slot}.ext4.$$"
    rm -f -- "$temporary_image"
    if ! (
      umask 077
      fallocate -l "$SLOT_IMAGE_BYTES" "$temporary_image"
      mkfs.ext4 \
        -F -q -L "vault-${slot}" \
        -N "$SLOT_FILESYSTEM_INODES" \
        -m 0 \
        -E nodiscard,lazy_itable_init=0,lazy_journal_init=0 \
        "$temporary_image"
      chown root:root "$temporary_image"
      chmod 0600 "$temporary_image"
      mv -T "$temporary_image" "$image"
    ); then
      rm -f -- "$temporary_image"
      echo "Failed to create preallocated slot image: ${slot}" >&2
      exit 1
    fi
  fi
  [[ -f "$image" && ! -L "$image" ]] || {
    echo "Slot image is not a regular file: ${image}" >&2
    exit 1
  }
  [[ "$(stat -c '%u:%g:%h:%a:%s' -- "$image")" \
      == "0:0:1:600:${SLOT_IMAGE_BYTES}" ]] || {
    echo "Slot image metadata is invalid: ${image}" >&2
    exit 1
  }
  allocated_bytes="$(( $(stat -c %b -- "$image") * 512 ))"
  (( allocated_bytes >= SLOT_IMAGE_BYTES )) || {
    echo "Slot image is sparse instead of preallocated: ${image}" >&2
    exit 1
  }
  [[ "$(blkid -p -s TYPE -o value "$image")" == "ext4" ]] || {
    echo "Slot image is not ext4: ${image}" >&2
    exit 1
  }
  inode_count="$(
    tune2fs -l "$image" 2>/dev/null |
      awk -F: '$1 == "Inode count" { gsub(/[[:space:]]/, "", $2); print $2 }'
  )"
  [[ "$inode_count" == "$SLOT_FILESYSTEM_INODES" ]] || {
    echo "Slot image inode budget is invalid: ${image}" >&2
    exit 1
  }

  install -d -o root -g root -m 0755 "$mountpoint"
  if mountpoint -q "$mountpoint"; then
    mounted_source="$(findmnt -rn -M "$mountpoint" -o SOURCE)"
    [[ "$mounted_source" == /dev/loop[0-9]* ]] || {
      echo "Refusing unexpected slot mount source: ${mounted_source}" >&2
      exit 1
    }
    backing_file="$(
      losetup --noheadings --output BACK-FILE "$mounted_source" |
        awk '{$1=$1; print}'
    )"
    [[ "$(readlink -f "$backing_file")" == "$image" ]] || {
      echo "Refusing slot mount backed by an unexpected image." >&2
      exit 1
    }
    umount "$mountpoint"
  fi
  [[ -d "$mountpoint" && ! -L "$mountpoint" ]] || {
    echo "Slot mountpoint is unsafe: ${mountpoint}" >&2
    exit 1
  }
  find "$mountpoint" -xdev -depth -mindepth 1 -delete
  chown root:root "$mountpoint"
  chmod 0755 "$mountpoint"

  # Mount units have an implicit Before=local-fs.target dependency. An
  # explicit After=local-fs.target would create a boot ordering cycle.
  cat >"$mount_unit_path" <<EOF
[Unit]
Description=Bounded Vault Lab filesystem for ${slot}
Before=vault-lab@${slot}.service vault-lab-loopback.service vault-lab-web.service

[Mount]
What=${image}
Where=${mountpoint}
Type=ext4
Options=loop,nodev,nosuid,noexec,noatime
TimeoutSec=30
EOF
  chmod 0644 "$mount_unit_path"
done

{
  printf '%s\n' \
    '[Unit]' \
    'Description=Bounded per-slot Vault Lab filesystems' \
    "Requires=${mount_units[*]}" \
    "After=${mount_units[*]}" \
    'Before=vault-lab-loopback.service vault-lab-web.service' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target'
} >/etc/systemd/system/vault-lab-storage.target
chmod 0644 /etc/systemd/system/vault-lab-storage.target

printf '%s\n' "$((10#$NATIVE_SLOT_COUNT))" \
  >/etc/vault-lab/native-slot-count
chmod 0644 /etc/vault-lab/native-slot-count
cat >/etc/vault-lab/slot-filesystem.env <<EOF
SLOT_IMAGE_BYTES=${SLOT_IMAGE_BYTES}
SLOT_FILESYSTEM_INODES=${SLOT_FILESYSTEM_INODES}
EOF
chmod 0644 /etc/vault-lab/slot-filesystem.env

cat >/etc/sysctl.d/90-vault-lab-native.conf <<'EOF'
# Keep low ports privileged so only vaultsvc-* with CAP_NET_BIND_SERVICE can
# occupy the fixed per-address Vault API/cluster endpoints.
net.ipv4.ip_unprivileged_port_start = 1024
EOF
chmod 0644 /etc/sysctl.d/90-vault-lab-native.conf
sysctl -q -w net.ipv4.ip_unprivileged_port_start=1024
[[ "$(sysctl -n net.ipv4.ip_unprivileged_port_start)" == "1024" ]] || {
  echo "Could not enforce privileged Vault API ports." >&2
  exit 1
}

install -o root -g root -m 0755 \
  "${NATIVE_DIR}/vault-lab-control" \
  /usr/local/sbin/vault-lab-control
install -o root -g root -m 0755 \
  "${NATIVE_DIR}/vault-lab-shell" \
  /usr/local/libexec/vault-lab-shell
install -o root -g root -m 0755 \
  "${NATIVE_DIR}/vault-lab-exec" \
  /usr/local/libexec/vault-lab-exec
install -o root -g root -m 0755 \
  "${NATIVE_DIR}/vault-lab-loopback" \
  /usr/local/sbin/vault-lab-loopback
install -o root -g root -m 0755 \
  "${NATIVE_DIR}/vault-lab-reaper" \
  /usr/local/sbin/vault-lab-reaper
install -o root -g root -m 0644 \
  "${NATIVE_DIR}/vault-lab@.service" \
  /etc/systemd/system/vault-lab@.service
install -o root -g root -m 0644 \
  "${NATIVE_DIR}/vault-lab-loopback.service" \
  /etc/systemd/system/vault-lab-loopback.service
install -o root -g root -m 0644 \
  "${NATIVE_DIR}/vault-lab-reaper.service" \
  /etc/systemd/system/vault-lab-reaper.service
install -o root -g root -m 0644 \
  "${NATIVE_DIR}/vault-lab-reaper.timer" \
  /etc/systemd/system/vault-lab-reaper.timer

cat >/etc/tmpfiles.d/vault-lab.conf <<'EOF'
d /run/vault-lab 0711 root root -
d /run/vault-lab/slots 0711 root root -
d /run/vault-lab/slots/.control 0700 root root -
d /run/vault-lab/app 0700 vault-lab vault-lab -
d /run/lock/vault-lab-control 0700 root root -
d /var/lib/vault-lab 0755 root root -
d /var/lib/vault-lab/sessions 0755 root root -
d /var/lib/vault-lab/images 0700 root root -
EOF

cat >/etc/sudoers.d/vault-lab-native <<'EOF'
Defaults:vault-lab env_reset
Defaults:vault-lab secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Defaults:vault-lab !set_home
vault-lab ALL=(root) NOPASSWD: /usr/local/sbin/vault-lab-control *
EOF
chmod 0440 /etc/sudoers.d/vault-lab-native
visudo -cf /etc/sudoers.d/vault-lab-native

# Disable the package's single-server unit. Lab instances only use our template.
systemctl disable --now vault.service >/dev/null 2>&1 || true
systemctl daemon-reload
systemd-tmpfiles --create /etc/tmpfiles.d/vault-lab.conf
systemctl enable vault-lab-storage.target
systemctl restart vault-lab-storage.target

for (( index=1; index<=10#$NATIVE_SLOT_COUNT; index+=1 )); do
  slot="$(printf 's%02d' "$index")"
  mountpoint="${STATE_ROOT}/${slot}"
  mount_data="$(findmnt -rn -M "$mountpoint" -o TARGET,FSTYPE,OPTIONS)"
  [[ "$mount_data" == "${mountpoint} ext4 "* ]] || {
    echo "Slot filesystem did not mount as ext4: ${slot}" >&2
    exit 1
  }
  for required_option in rw nodev nosuid noexec; do
    [[ ",${mount_data#* ext4 }," == *",${required_option},"* ]] || {
      echo "Slot filesystem is missing ${required_option}: ${slot}" >&2
      exit 1
    }
  done
  chown root:root "$mountpoint"
  chmod 0711 "$mountpoint"
  marker_temporary="$(mktemp "${mountpoint}/.vault-lab-slot.XXXXXX")"
  printf 'vault-lab:%s:v1\n' "$slot" >"$marker_temporary"
  chown root:root "$marker_temporary"
  chmod 0400 "$marker_temporary"
  mv -fT "$marker_temporary" "${mountpoint}/.vault-lab-slot"
  /usr/local/sbin/vault-lab-control prepare "$slot"
done

# Validate installed unit syntax before handing the host to the application deploy.
systemd-analyze verify \
  /etc/systemd/system/vault-lab@.service \
  /etc/systemd/system/vault-lab-loopback.service \
  /etc/systemd/system/vault-lab-reaper.service \
  /etc/systemd/system/vault-lab-reaper.timer \
  /etc/systemd/system/vault-lab-storage.target \
  "${mount_units[@]/#//etc/systemd/system/}"

restorecon -RF \
  /usr/local/sbin/vault-lab-control \
  /usr/local/sbin/vault-lab-reaper \
  /usr/local/sbin/vault-lab-loopback \
  /usr/local/libexec/vault-lab-shell \
  /usr/local/libexec/vault-lab-exec \
  /var/lib/vault-lab \
  /run/vault-lab 2>/dev/null || true

# Only the trusted native support services return after every mutable artifact
# and unit has passed validation. The web service deliberately remains disabled
# until the separate application deployment succeeds.
systemctl enable vault-lab-loopback.service
systemctl restart vault-lab-loopback.service
systemctl is-active --quiet vault-lab-loopback.service
systemctl start vault-lab-reaper.service
[[ "$(systemctl show -p Result --value vault-lab-reaper.service)" == "success" ]]
systemctl enable --now vault-lab-reaper.timer
systemctl is-active --quiet vault-lab-reaper.timer

# Commit the exact ABI only after the host, helpers, units, and storage have
# all passed validation. The web process refuses to initialize without it.
sync
abi_marker_temporary="/etc/vault-lab/.native-control-abi.$$"
rm -f -- "$abi_marker_temporary"
install -o root -g root -m 0644 \
  "${NATIVE_DIR}/CONTROL_ABI" \
  "$abi_marker_temporary"
cmp -s -- "${NATIVE_DIR}/CONTROL_ABI" "$abi_marker_temporary"
[[ "$(stat -c '%u:%g:%a' -- "$abi_marker_temporary")" == "0:0:644" ]]
sync -f "$abi_marker_temporary"
mv -fT -- "$abi_marker_temporary" /etc/vault-lab/native-control-abi
sync -f /etc/vault-lab/native-control-abi
sync -f /etc/vault-lab

echo "Native Vault runtime installed."
echo "Vault: $(/usr/local/bin/vault version)"
echo "Slots: ${NATIVE_SLOT_COUNT}"
echo "Application user: vault-lab"
echo "Next: deploy the Git checkout to /opt/vault-lab and run the Node service as vault-lab."
