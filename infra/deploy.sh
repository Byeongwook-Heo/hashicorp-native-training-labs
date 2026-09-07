#!/usr/bin/env bash
set -Eeuo pipefail

umask 0077

: "${LAB_PROFILE:=vault}"
case "$LAB_PROFILE" in
  vault)
    readonly PROFILE_DEFAULT_NAME="vault-training-lab-green"
    readonly PROFILE_DEFAULT_INSTANCE_PROFILE_NAME="vault-lab-native-ec2-profile"
    readonly PROFILE_DEFAULT_INSTANCE_ROLE_NAME="vault-lab-native-ec2-role"
    readonly PROFILE_DEFAULT_SSM_PARAMETER_PREFIX="/vault-lab/bootstrap"
    readonly PROFILE_DEFAULT_ADMIN_EMAIL="admin@vault-lab.local"
    readonly PROFILE_DEFAULT_SECURITY_GROUP_ID=""
    readonly PROJECT_TAG="VaultLab"
    readonly PRODUCT_PREFIX="vault-lab"
    readonly PARAMETER_TAG="VaultLabDeployKeyParameter"
    readonly APP_ROOT="/opt/vault-lab"
    readonly USER_DATA_FILE="infra/ec2-user-data.sh"
    readonly GIT_SSH_WRAPPER="/usr/local/bin/vault-lab-git-ssh"
    readonly INSTALL_SCRIPT="infra/install-application.sh"
    readonly CUTOVER_SCRIPT="infra/cutover-caddy.sh"
    readonly CLOUD_READY="/var/lib/vault-lab/cloud-init-ready"
    readonly LAB_LABEL="Vault Lab"
    readonly COURSE_ID="vault-foundations"
    ;;
  terraform)
    readonly PROFILE_DEFAULT_NAME="terraform-training-lab-green"
    readonly PROFILE_DEFAULT_INSTANCE_PROFILE_NAME="terraform-lab-native-ec2-profile"
    readonly PROFILE_DEFAULT_INSTANCE_ROLE_NAME="terraform-lab-native-ec2-role"
    readonly PROFILE_DEFAULT_SSM_PARAMETER_PREFIX="/terraform-lab/bootstrap"
    readonly PROFILE_DEFAULT_ADMIN_EMAIL="admin@terraform-lab.local"
    readonly PROFILE_DEFAULT_SECURITY_GROUP_ID=""
    readonly PROJECT_TAG="TerraformLab"
    readonly PRODUCT_PREFIX="terraform-lab"
    readonly PARAMETER_TAG="TerraformLabDeployKeyParameter"
    readonly APP_ROOT="/opt/terraform-lab"
    readonly USER_DATA_FILE="infra/terraform-ec2-user-data.sh"
    readonly GIT_SSH_WRAPPER="/usr/local/bin/terraform-lab-git-ssh"
    readonly INSTALL_SCRIPT="infra/install-terraform-application.sh"
    readonly CUTOVER_SCRIPT="infra/terraform-cutover-caddy.sh"
    readonly CLOUD_READY="/var/lib/terraform-lab/cloud-init-ready"
    readonly LAB_LABEL="Terraform Lab"
    readonly COURSE_ID="terraform-foundations"
    ;;
  *)
    echo "LAB_PROFILE은 vault 또는 terraform이어야 합니다." >&2
    exit 1
    ;;
esac

: "${AWS_REGION:=ap-northeast-2}"
: "${SUBNET_ID:?Set SUBNET_ID for your environment}"
: "${SECURITY_GROUP_ID:=$PROFILE_DEFAULT_SECURITY_GROUP_ID}"
: "${SECURITY_GROUP_ID:?Set SECURITY_GROUP_ID for the selected lab profile}"
: "${INSTANCE_TYPE:=t3.medium}"
: "${ROOT_VOLUME_GB:=30}"
: "${NATIVE_SLOT_COUNT:=4}"
: "${NAME:=$PROFILE_DEFAULT_NAME}"
: "${INSTANCE_PROFILE_NAME:=$PROFILE_DEFAULT_INSTANCE_PROFILE_NAME}"
: "${INSTANCE_ROLE_NAME:=$PROFILE_DEFAULT_INSTANCE_ROLE_NAME}"
: "${GITHUB_REPOSITORY:=Byeongwook-Heo/hashicorp-native-training-labs}"
: "${GITHUB_REPOSITORY_SSH:=git@github.com:Byeongwook-Heo/hashicorp-native-training-labs.git}"
: "${DEPLOY_BRANCH:=main}"
: "${SSM_PARAMETER_PREFIX:=$PROFILE_DEFAULT_SSM_PARAMETER_PREFIX}"
: "${SSM_KMS_KEY_ID:=}"
APPROVED_AMI_ID="${APPROVED_AMI_ID-}"
: "${RESOLVE_LATEST_APPROVED_AMI:=false}"
: "${ALLOCATE_EIP:=true}"
: "${AUTO_INSTALL:=true}"
: "${KEEP_FAILED_CANDIDATE:=false}"
: "${LAB_HOST:=}"
: "${LAB_ADMIN_EMAIL:=$PROFILE_DEFAULT_ADMIN_EMAIL}"
LAB_LEGACY_HOST="${LAB_LEGACY_HOST-}"
ROUTE53_HOSTED_ZONE_ID="${ROUTE53_HOSTED_ZONE_ID-}"
readonly APPROVED_AMI_OWNER_ID="888995627335"
readonly DEPLOY_KEY_PUBLIC="${CLOUD_READY%/*}/deploy-key.pub"

if [[ "$LAB_PROFILE" == "terraform" && -z "$SECURITY_GROUP_ID" ]]; then
  echo "Terraform profile에는 80/443만 허용하는 전용 SECURITY_GROUP_ID가 필요합니다." >&2
  exit 1
fi
if [[ "$LAB_PROFILE" == "terraform" ]]; then
  for terraform_host in "$LAB_HOST" "$LAB_LEGACY_HOST"; do
    if [[ -n "$terraform_host" && "$terraform_host" != terraform-lab.* ]]; then
      echo "Terraform profile의 명시적 host는 terraform-lab. prefix가 필요합니다: ${terraform_host}" >&2
      exit 1
    fi
  done
fi

for command_name in aws gh jq openssl ssh-keygen; do
  command -v "$command_name" >/dev/null || {
    echo "필수 명령이 없습니다: ${command_name}" >&2
    exit 1
  }
done
if [[ ! -f "$USER_DATA_FILE" || ! -r "$USER_DATA_FILE" ]]; then
  echo "배포 프로필의 EC2 user-data 파일을 읽을 수 없습니다: ${USER_DATA_FILE}" >&2
  exit 1
fi
if [[ "$AUTO_INSTALL" == "true" && ! -x "$INSTALL_SCRIPT" ]]; then
  echo "배포 프로필의 설치 스크립트를 실행할 수 없습니다: ${INSTALL_SCRIPT}" >&2
  exit 1
fi
if [[ -n "$ROUTE53_HOSTED_ZONE_ID" && ! -x "$CUTOVER_SCRIPT" ]]; then
  echo "배포 프로필의 Caddy 전환 스크립트를 실행할 수 없습니다: ${CUTOVER_SCRIPT}" >&2
  exit 1
fi
if [[ ! "$AWS_REGION" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ \
  || ! "$SUBNET_ID" =~ ^subnet-[a-f0-9]+$ \
  || ! "$SECURITY_GROUP_ID" =~ ^sg-[a-f0-9]+$ ]]; then
  echo "AWS_REGION/SUBNET_ID/SECURITY_GROUP_ID 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ ! "$ROOT_VOLUME_GB" =~ ^[0-9]+$ ]] \
  || (( 10#$ROOT_VOLUME_GB < 20 || 10#$ROOT_VOLUME_GB > 1024 )); then
  echo "ROOT_VOLUME_GB는 20부터 1024 사이의 정수여야 합니다." >&2
  exit 1
fi
if [[ ! "$NATIVE_SLOT_COUNT" =~ ^[0-9]+$ ]] \
  || (( 10#$NATIVE_SLOT_COUNT < 1 || 10#$NATIVE_SLOT_COUNT > 20 )); then
  echo "NATIVE_SLOT_COUNT는 1부터 20 사이의 정수여야 합니다." >&2
  exit 1
fi
if [[ ! "$DEPLOY_BRANCH" =~ ^[A-Za-z0-9._/-]+$ \
  || "$DEPLOY_BRANCH" == -* \
  || "$DEPLOY_BRANCH" == *".."* ]]; then
  echo "DEPLOY_BRANCH 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ ! "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ \
  || ! "$GITHUB_REPOSITORY_SSH" =~ ^git@github\.com:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]]; then
  echo "GitHub 저장소 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ "$GITHUB_REPOSITORY_SSH" != "git@github.com:${GITHUB_REPOSITORY}.git" ]]; then
  echo "GITHUB_REPOSITORY와 GITHUB_REPOSITORY_SSH가 같은 저장소를 가리켜야 합니다." >&2
  exit 1
fi
if [[ ! "$NAME" =~ ^[A-Za-z0-9._-]+$ \
  || ! "$INSTANCE_PROFILE_NAME" =~ ^[A-Za-z0-9+=,.@_-]+$ \
  || ! "$INSTANCE_ROLE_NAME" =~ ^[A-Za-z0-9+=,.@_-]+$ \
  || ! "$SSM_PARAMETER_PREFIX" =~ ^/[A-Za-z0-9_.@/-]+$ ]]; then
  echo "NAME/IAM 이름/SSM_PARAMETER_PREFIX 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ -n "$SSM_KMS_KEY_ID" \
  && ! "$SSM_KMS_KEY_ID" =~ ^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$ ]]; then
  echo "SSM_KMS_KEY_ID는 KMS key ARN이어야 합니다." >&2
  exit 1
fi
if [[ -n "$APPROVED_AMI_ID" \
  && ! "$APPROVED_AMI_ID" =~ ^ami-[a-f0-9]{8,17}$ ]]; then
  echo "APPROVED_AMI_ID 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ -n "$ROUTE53_HOSTED_ZONE_ID" \
  && ! "$ROUTE53_HOSTED_ZONE_ID" =~ ^Z[A-Z0-9]+$ ]]; then
  echo "ROUTE53_HOSTED_ZONE_ID 형식이 올바르지 않습니다." >&2
  exit 1
fi
if [[ -n "$ROUTE53_HOSTED_ZONE_ID" \
  && ( -z "$LAB_HOST" || "$AUTO_INSTALL" != "true" ) ]]; then
  echo "Route 53 전환에는 LAB_HOST와 AUTO_INSTALL=true가 필요합니다." >&2
  exit 1
fi
if [[ "$LAB_ADMIN_EMAIL" == *$'\n'* || "$LAB_ADMIN_EMAIL" != *@* ]]; then
  echo "LAB_ADMIN_EMAIL 형식이 올바르지 않습니다." >&2
  exit 1
fi
for boolean_value in \
  "$ALLOCATE_EIP" \
  "$AUTO_INSTALL" \
  "$KEEP_FAILED_CANDIDATE" \
  "$RESOLVE_LATEST_APPROVED_AMI"; do
  if [[ "$boolean_value" != "true" && "$boolean_value" != "false" ]]; then
    echo "배포 boolean 환경 변수는 true 또는 false여야 합니다." >&2
    exit 1
  fi
done
for host_value in "$LAB_HOST" "$LAB_LEGACY_HOST"; do
  if [[ -n "$host_value" && ! "$host_value" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "LAB_HOST/LAB_LEGACY_HOST 형식이 올바르지 않습니다." >&2
    exit 1
  fi
done

deployment_id="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
readonly deployment_id
readonly client_token="${PRODUCT_PREFIX}-${deployment_id}"
readonly deploy_key_title="${PRODUCT_PREFIX}-blue-green-${deployment_id}"
readonly parameter_name="${SSM_PARAMETER_PREFIX}/${deployment_id}/github-key"
temporary_dir="$(mktemp -d)"
readonly temporary_dir
readonly private_key_file="${temporary_dir}/github_ed25519"
readonly parameter_input_file="${temporary_dir}/ssm-parameter.json"
readonly trust_policy_file="${temporary_dir}/ec2-trust.json"
readonly ssm_core_policy_file="${temporary_dir}/ssm-core-policy.json"
readonly inline_policy_file="${temporary_dir}/bootstrap-policy.json"
readonly command_parameters_file="${temporary_dir}/command-parameters.json"
readonly route53_change_file="${temporary_dir}/route53-change.json"
readonly route53_previous_file="${temporary_dir}/route53-previous.json"
readonly route53_rollback_file="${temporary_dir}/route53-rollback.json"
readonly ssm_core_policy_name="${PROJECT_TAG}SsmCore"
readonly inline_policy_name="${PROJECT_TAG}Bootstrap-${deployment_id}"
parameter_created=false
inline_policy_created=false
deploy_key_created=false
deploy_key_id=""
instance_id=""
allocation_id=""
public_ip=""
dns_change_attempted=false
dns_changed=false
candidate_cleanup_blocked=false
run_instances_attempted=false

resolve_created_deploy_key_id() {
  local deploy_keys_json
  local matching_key_count

  if [[ "$deploy_key_id" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  deploy_keys_json="$(gh api "repos/${GITHUB_REPOSITORY}/keys?per_page=100")" \
    || return 1
  matching_key_count="$(
    jq -r \
      --arg title "$deploy_key_title" \
      '[.[] | select(.title == $title)] | length' \
      <<<"$deploy_keys_json"
  )"
  [[ "$matching_key_count" == "1" ]] || return 1
  deploy_key_id="$(
    jq -r \
      --arg title "$deploy_key_title" \
      '.[] | select(.title == $title) | .id' \
      <<<"$deploy_keys_json"
  )"
  [[ "$deploy_key_id" =~ ^[0-9]+$ ]]
}

delete_created_deploy_key() {
  if [[ "$deploy_key_created" != "true" ]]; then
    return 0
  fi
  if ! resolve_created_deploy_key_id; then
    echo "이번 배포의 GitHub Deploy Key ID를 정확히 확인하지 못해 보존합니다: ${deploy_key_title}" >&2
    return 1
  fi
  if ! gh api \
    --method DELETE \
    "repos/${GITHUB_REPOSITORY}/keys/${deploy_key_id}" >/dev/null; then
    echo "이번 배포의 GitHub Deploy Key를 삭제하지 못했습니다: ${deploy_key_title} (${deploy_key_id})" >&2
    return 1
  fi
  deploy_key_created=false
  echo "이번 배포가 만든 GitHub Deploy Key를 삭제했습니다: ${deploy_key_title}" >&2
}

candidate_instance_matches_deployment() {
  local instance_json

  [[ "$instance_id" =~ ^i-[a-f0-9]{8,17}$ ]] || return 1
  instance_json="$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --output json)" || return 1
  jq -e \
    --arg instance_id "$instance_id" \
    --arg name "$NAME" \
    --arg project_tag "$PROJECT_TAG" \
    --arg parameter_tag "$PARAMETER_TAG" \
    --arg parameter_name "$parameter_name" \
    --arg slot_count "$NATIVE_SLOT_COUNT" \
    --arg ami_id "$ami_id" \
    --arg ami_name "$ami_name" \
    --arg ami_owner_id "$ami_owner_id" \
    --arg client_token "$client_token" \
    --arg deployment_id "$deployment_id" \
    '
      def tag_value($key):
        [(.Reservations[0].Instances[0].Tags // [])[]
          | select(.Key == $key)
          | .Value]
        | if length == 1 then .[0] else null end;
      .Reservations[0].Instances[0].InstanceId == $instance_id
      and .Reservations[0].Instances[0].ImageId == $ami_id
      and .Reservations[0].Instances[0].ClientToken == $client_token
      and tag_value("Name") == $name
      and tag_value("Project") == $project_tag
      and ($project_tag != "VaultLab" or tag_value("Project") == "VaultLab")
      and tag_value("Runtime") == "Native"
      and tag_value("Deployment") == "BlueGreenCandidate"
      and tag_value("DeploymentId") == $deployment_id
      and tag_value("NativeSlots") == $slot_count
      and tag_value($parameter_tag) == $parameter_name
      and ($parameter_tag != "VaultLabDeployKeyParameter" or tag_value("VaultLabDeployKeyParameter") == $parameter_name)
      and tag_value("BaseAmiId") == $ami_id
      and tag_value("BaseAmiName") == $ami_name
      and tag_value("BaseAmiOwner") == $ami_owner_id
      and tag_value("AmiCompliance") == "Approved"
    ' <<<"$instance_json" >/dev/null
}

candidate_image_metadata_matches_deployment() {
  local image_metadata_json

  [[ "$instance_id" =~ ^i-[a-f0-9]{8,17}$ ]] || return 1
  image_metadata_json="$(aws ec2 describe-instance-image-metadata \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --output json)" || return 1
  jq -e \
    --arg instance_id "$instance_id" \
    --arg ami_id "$ami_id" \
    --arg ami_name "$ami_name" \
    --arg ami_owner_id "$ami_owner_id" \
    '
      .InstanceImageMetadata
      | length == 1
        and .[0].InstanceId == $instance_id
        and .[0].ImageMetadata.ImageAllowed != false
        and .[0].ImageMetadata.ImageId == $ami_id
        and .[0].ImageMetadata.OwnerId == $ami_owner_id
        and .[0].ImageMetadata.Name == $ami_name
        and .[0].ImageMetadata.State == "available"
    ' <<<"$image_metadata_json" >/dev/null
}

recover_candidate_instance_id() {
  local recovered_instance_id
  local recovery_instances_json

  recovery_instances_json="$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --filters \
      "Name=client-token,Values=${client_token}" \
      "Name=tag:Project,Values=${PROJECT_TAG}" \
      "Name=tag:DeploymentId,Values=${deployment_id}" \
    --output json)" || return 1
  recovered_instance_id="$(jq -r '
    [
      .Reservations[].Instances[]
      | select(.State.Name != "terminated")
    ]
    | if length == 1 then .[0].InstanceId else empty end
  ' <<<"$recovery_instances_json")"
  [[ "$recovered_instance_id" =~ ^i-[a-f0-9]{8,17}$ ]] || return 1
  instance_id="$recovered_instance_id"
}

candidate_eip_matches_deployment() {
  local address_json

  [[ "$allocation_id" =~ ^eipalloc-[a-f0-9]{8,17}$ ]] || return 1
  address_json="$(aws ec2 describe-addresses \
    --region "$AWS_REGION" \
    --allocation-ids "$allocation_id" \
    --output json)" || return 1
  jq -e \
    --arg allocation_id "$allocation_id" \
    --arg instance_id "$instance_id" \
    --arg name "$NAME" \
    --arg project_tag "$PROJECT_TAG" \
    --arg deployment_id "$deployment_id" \
    '
      def tag_value($key):
        [(.Addresses[0].Tags // [])[]
          | select(.Key == $key)
          | .Value]
        | if length == 1 then .[0] else null end;
      .Addresses[0].AllocationId == $allocation_id
      and (
        .Addresses[0].AssociationId == null
        or .Addresses[0].InstanceId == $instance_id
      )
      and tag_value("Name") == $name
      and tag_value("Project") == $project_tag
      and ($project_tag != "VaultLab" or tag_value("Project") == "VaultLab")
      and tag_value("Deployment") == "BlueGreenCandidate"
      and tag_value("DeploymentId") == $deployment_id
    ' <<<"$address_json" >/dev/null
}

candidate_eip_is_safe_to_release() {
  local address_json

  [[ "$allocation_id" =~ ^eipalloc-[a-f0-9]{8,17}$ ]] || return 1
  address_json="$(aws ec2 describe-addresses \
    --region "$AWS_REGION" \
    --allocation-ids "$allocation_id" \
    --output json)" || return 1
  jq -e \
    --arg allocation_id "$allocation_id" \
    --arg name "$NAME" \
    --arg project_tag "$PROJECT_TAG" \
    --arg deployment_id "$deployment_id" \
    '
      def tag_value($key):
        [(.Addresses[0].Tags // [])[]
          | select(.Key == $key)
          | .Value]
        | if length == 1 then .[0] else null end;
      .Addresses[0].AllocationId == $allocation_id
      and .Addresses[0].AssociationId == null
      and .Addresses[0].InstanceId == null
      and tag_value("Name") == $name
      and tag_value("Project") == $project_tag
      and ($project_tag != "VaultLab" or tag_value("Project") == "VaultLab")
      and tag_value("Deployment") == "BlueGreenCandidate"
      and tag_value("DeploymentId") == $deployment_id
    ' <<<"$address_json" >/dev/null
}

cleanup_created_candidate() {
  local candidate_eip_verified=false
  local candidate_cleanup_complete=true
  local eip_released=false
  local _release_attempt

  if ! candidate_instance_matches_deployment; then
    echo "이번 실행이 만든 EC2인지 정확히 검증하지 못해 후보 자원을 보존합니다: ${instance_id}" >&2
    return 1
  fi
  if [[ -n "$allocation_id" ]]; then
    if candidate_eip_matches_deployment; then
      candidate_eip_verified=true
    else
      candidate_cleanup_complete=false
      echo "이번 실행이 만든 EIP인지 정확히 검증하지 못해 EIP는 보존합니다: ${allocation_id}" >&2
    fi
  fi

  if ! aws ec2 terminate-instances \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" >/dev/null \
    || ! aws ec2 wait instance-terminated \
      --region "$AWS_REGION" \
      --instance-ids "$instance_id"; then
    echo "실패 후보 EC2의 종료를 확인하지 못해 연결 자원을 보존합니다: ${instance_id}" >&2
    return 1
  fi
  echo "이번 배포가 만든 실패 후보 EC2를 종료했습니다: ${instance_id}" >&2

  if [[ "$candidate_eip_verified" == "true" ]]; then
    eip_released=false
    for _release_attempt in {1..12}; do
      if candidate_eip_is_safe_to_release \
        && aws ec2 release-address \
        --region "$AWS_REGION" \
        --allocation-id "$allocation_id" >/dev/null 2>&1; then
        eip_released=true
        break
      fi
      sleep 5
    done
    if [[ "$eip_released" == "true" ]]; then
      echo "이번 배포가 만든 Elastic IP를 해제했습니다: ${allocation_id}" >&2
      allocation_id=""
    else
      candidate_cleanup_complete=false
      echo "종료된 후보의 Elastic IP를 해제하지 못해 수동 확인이 필요합니다: ${allocation_id}" >&2
    fi
  fi

  if ! delete_created_deploy_key; then
    candidate_cleanup_complete=false
  fi
  [[ "$candidate_cleanup_complete" == "true" ]]
}

cleanup() {
  local status=$?
  local candidate_cleanup_safe=true
  local candidate_cleanup_complete=false
  trap - EXIT
  set +e
  if (( status != 0 )) && [[ "$candidate_cleanup_blocked" == "true" ]]; then
    candidate_cleanup_safe=false
    echo "주의: 배포 전부터 DNS가 후보 IP를 가리켜 자동 후보 정리를 차단합니다." >&2
  elif (( status != 0 )) && [[ "$dns_change_attempted" == "true" ]]; then
    candidate_cleanup_safe=false
    if [[ "$dns_changed" == "true" ]] \
      && [[ -n "$ROUTE53_HOSTED_ZONE_ID" ]]; then
      if [[ -s "$route53_previous_file" ]]; then
        if jq -e \
          --slurpfile change "$route53_change_file" \
          '. == (
            $change[0].Changes[]
            | select(.Action == "CREATE")
            | .ResourceRecordSet
          )' \
          "$route53_previous_file" >/dev/null; then
          candidate_cleanup_blocked=true
          echo "주의: 이전 DNS와 후보 record가 같아 후보 자원을 자동 정리하지 않습니다." >&2
        else
          jq -n \
            --arg comment "Rollback failed ${LAB_LABEL} blue/green deployment" \
            --slurpfile previous "$route53_previous_file" \
            --slurpfile change "$route53_change_file" \
            '{
              Comment: $comment,
              Changes: [
                {
                  Action: "DELETE",
                  ResourceRecordSet: (
                    $change[0].Changes[]
                    | select(.Action == "CREATE")
                    | .ResourceRecordSet
                  )
                },
                {
                  Action: "CREATE",
                  ResourceRecordSet: $previous[0]
                }
              ]
            }' >"$route53_rollback_file"
        fi
      else
        jq -n \
          --arg comment "Remove failed ${LAB_LABEL} blue/green candidate" \
          --slurpfile change "$route53_change_file" \
          '{
            Comment: $comment,
            Changes: [{
              Action: "DELETE",
              ResourceRecordSet: (
                $change[0].Changes[]
                | select(.Action == "CREATE")
                | .ResourceRecordSet
              )
            }]
          }' >"$route53_rollback_file"
      fi
      if [[ "$candidate_cleanup_blocked" != "true" ]] \
        && rollback_change_id="$(
        aws route53 change-resource-record-sets \
          --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
          --change-batch "file://${route53_rollback_file}" \
          --query ChangeInfo.Id \
          --output text
      )" \
        && aws route53 wait resource-record-sets-changed \
          --id "$rollback_change_id"; then
        candidate_cleanup_safe=true
        dns_changed=false
        echo "실패한 후보의 Route 53 변경을 이전 상태로 복구했습니다." >&2
      else
        if [[ "$candidate_cleanup_blocked" != "true" ]]; then
          echo "주의: Route 53 exact rollback에 실패했습니다. 동시 변경을 덮어쓰지 않고 후보 자원을 보존합니다." >&2
        fi
      fi
    else
      echo "주의: Route 53 변경 결과를 확정하지 못해 후보 자원을 보존합니다." >&2
    fi
  fi
  if (( status != 0 )) \
    && [[ -z "$instance_id" ]] \
    && [[ "$run_instances_attempted" == "true" ]]; then
    for _recovery_attempt in {1..6}; do
      if recover_candidate_instance_id; then
        echo "동일 client token으로 실패 후보 EC2를 복구 확인했습니다: ${instance_id}" >&2
        break
      fi
      sleep 2
    done
  fi
  if [[ "$parameter_created" == "true" ]]; then
    aws ssm delete-parameter \
      --region "$AWS_REGION" \
      --name "$parameter_name" >/dev/null
  fi
  if [[ "$inline_policy_created" == "true" ]]; then
    aws iam delete-role-policy \
      --role-name "$INSTANCE_ROLE_NAME" \
      --policy-name "$inline_policy_name" >/dev/null
  fi
  if (( status != 0 )) && [[ -z "$instance_id" ]]; then
    delete_created_deploy_key || true
  fi
  if (( status != 0 )) \
    && [[ -n "$instance_id" ]] \
    && [[ "$KEEP_FAILED_CANDIDATE" == "false" ]] \
    && [[ "$candidate_cleanup_safe" == "true" ]]; then
    if cleanup_created_candidate; then
      candidate_cleanup_complete=true
    fi
  fi
  if (( status != 0 )) \
    && [[ -n "$instance_id" ]] \
    && [[ "$candidate_cleanup_complete" != "true" ]]; then
    echo "실패 후보의 남은 자원은 안전한 수동 확인을 위해 보존했습니다." >&2
    echo "  EC2 instance: ${instance_id}" >&2
    if [[ -n "$allocation_id" ]]; then
      echo "  Elastic IP allocation: ${allocation_id}" >&2
    fi
    if [[ -n "$public_ip" ]]; then
      echo "  Public IP: ${public_ip}" >&2
    fi
    if [[ "$deploy_key_created" == "true" ]]; then
      echo "  GitHub Deploy Key: ${deploy_key_title}" >&2
    fi
  fi
  find "$temporary_dir" -mindepth 1 -delete
  rmdir "$temporary_dir"
  exit "$status"
}
trap cleanup EXIT

wait_for_ssm_command() {
  local command_id="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  local command_status

  while (( SECONDS < deadline )); do
    if ! command_status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$command_id" \
      --instance-id "$instance_id" \
      --query Status \
      --output text 2>/dev/null)"; then
      command_status="Pending"
    fi
    case "$command_status" in
      Success)
        return 0
        ;;
      Cancelled|Cancelling|Failed|TimedOut)
        aws ssm get-command-invocation \
          --region "$AWS_REGION" \
          --command-id "$command_id" \
          --instance-id "$instance_id" \
          --query StandardErrorContent \
          --output text >&2 || true
        echo "SSM command 실패 상태: ${command_status}" >&2
        return 1
        ;;
    esac
    sleep 5
  done

  echo "SSM command 완료 대기 시간이 초과되었습니다: ${command_id}" >&2
  return 1
}

capture_candidate_boot_id() {
  local boot_command_id
  local boot_id

  jq -n '{commands: ["cat /proc/sys/kernel/random/boot_id"]}' \
    >"$command_parameters_file"
  boot_command_id="$(aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --comment "Read ${LAB_LABEL} candidate boot ID" \
    --parameters "file://${command_parameters_file}" \
    --timeout-seconds 60 \
    --query 'Command.CommandId' \
    --output text)"
  wait_for_ssm_command "$boot_command_id" 60
  boot_id="$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$boot_command_id" \
    --instance-id "$instance_id" \
    --query StandardOutputContent \
    --output text | tr -d '\r\n')"
  [[ "$boot_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] \
    || return 1
  printf '%s\n' "$boot_id"
}

capture_candidate_release_commit() {
  local release_command_id
  local release_commit

  jq -n --arg current "${APP_ROOT}/current" \
    '{commands: [("basename \"$(readlink -f " + $current + ")\"")]}' \
    >"$command_parameters_file"
  release_command_id="$(aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --comment "Read ${LAB_LABEL} candidate release commit" \
    --parameters "file://${command_parameters_file}" \
    --timeout-seconds 60 \
    --query 'Command.CommandId' \
    --output text)"
  wait_for_ssm_command "$release_command_id" 60
  release_commit="$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$release_command_id" \
    --instance-id "$instance_id" \
    --query StandardOutputContent \
    --output text | tr -d '\r\n')"
  [[ "$release_commit" =~ ^[a-f0-9]{40}$ ]] || return 1
  printf '%s\n' "$release_commit"
}

reboot_terraform_candidate_before_cutover() {
  local before_boot_id
  local after_boot_id=""
  local expected_commit
  local ping_status
  local reboot_confirmed=false
  local reboot_smoke_command
  local reboot_smoke_command_id
  local reboot_deadline=$((SECONDS + 900))

  expected_commit="$(capture_candidate_release_commit)"
  before_boot_id="$(capture_candidate_boot_id)"
  aws ec2 reboot-instances \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id"

  while (( SECONDS < reboot_deadline )); do
    ping_status="$(aws ssm describe-instance-information \
      --region "$AWS_REGION" \
      --filters "Key=InstanceIds,Values=${instance_id}" \
      --query 'InstanceInformationList[0].PingStatus' \
      --output text 2>/dev/null || true)"
    if [[ "$ping_status" == "Online" ]] \
      && after_boot_id="$(capture_candidate_boot_id 2>/dev/null)" \
      && [[ "$after_boot_id" != "$before_boot_id" ]]; then
      reboot_confirmed=true
      break
    fi
    sleep 5
  done
  if [[ "$reboot_confirmed" != "true" ]]; then
    echo "Terraform 후보의 재부팅을 boot ID로 확인하지 못했습니다." >&2
    return 1
  fi

  aws ec2 wait instance-status-ok \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id"
  reboot_smoke_command="$(printf '%q ' \
    env \
    EXPECTED_COMMIT="$expected_commit" \
    "${APP_ROOT}/current/infra/terraform-reboot-smoke-deployment.sh")"
  jq -n --arg command "$reboot_smoke_command" \
    '{commands: ["set -euo pipefail", $command]}' \
    >"$command_parameters_file"
  reboot_smoke_command_id="$(aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --comment "Smoke ${LAB_LABEL} after mandatory pre-cutover reboot" \
    --parameters "file://${command_parameters_file}" \
    --timeout-seconds 1200 \
    --query 'Command.CommandId' \
    --output text)"
  wait_for_ssm_command "$reboot_smoke_command_id" 1200
  echo "Terraform 후보가 DNS 전환 전 재부팅·슬롯 smoke를 통과했습니다: ${instance_id}"
}

is_ipv4_address() {
  local address="$1"
  local octet
  local -a octets

  [[ "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a octets <<<"$address"
  for octet in "${octets[@]}"; do
    (( 10#$octet <= 255 )) || return 1
  done
}

account_id="$(aws sts get-caller-identity --query Account --output text)"
if [[ ! "$account_id" =~ ^[0-9]{12}$ ]]; then
  echo "AWS account ID를 확인하지 못했습니다." >&2
  exit 1
fi

if [[ -z "$APPROVED_AMI_ID" \
  && "$RESOLVE_LATEST_APPROVED_AMI" != "true" ]]; then
  echo "APPROVED_AMI_ID를 명시해야 합니다. 최신 승인 prefix 자동 선택은 RESOLVE_LATEST_APPROVED_AMI=true일 때만 허용됩니다." >&2
  exit 1
fi

if [[ -n "$APPROVED_AMI_ID" ]]; then
  ami_id="$APPROVED_AMI_ID"
else
  approved_ami_candidates="$(
    aws ec2 describe-images \
      --region "$AWS_REGION" \
      --owners "$APPROVED_AMI_OWNER_ID" \
      --filters \
        'Name=name,Values=hc-security-base-al2023-x86_64-*,hc-base-al2023-x86_64-*' \
        'Name=state,Values=available' \
        'Name=architecture,Values=x86_64' \
        'Name=root-device-type,Values=ebs' \
        'Name=virtualization-type,Values=hvm' \
      --output json
  )"
  ami_id="$(
    jq -r \
      '.Images
        | map(select(.RootDeviceName == "/dev/xvda"))
        | sort_by(.CreationDate)
        | reverse
        | .[0].ImageId // empty' \
      <<<"$approved_ami_candidates"
  )"
fi
[[ "$ami_id" =~ ^ami-[a-f0-9]{8,17}$ ]] || {
  echo "승인된 AL2023 base AMI 후보를 찾지 못했습니다." >&2
  exit 1
}

if ! approved_ami_json="$(aws ec2 describe-images \
    --region "$AWS_REGION" \
    --owners "$APPROVED_AMI_OWNER_ID" \
    --image-ids "$ami_id" \
    --output json 2>/dev/null)"; then
  echo "AMI가 고정된 승인 소유자에게 속하지 않거나 조회할 수 없습니다: ${ami_id}" >&2
  exit 1
fi
if ! jq -e \
  --arg ami_id "$ami_id" \
  --arg owner_id "$APPROVED_AMI_OWNER_ID" \
  --argjson root_volume_gb "$ROOT_VOLUME_GB" \
  '
    .Images
    | length == 1
      and .[0].ImageId == $ami_id
      and .[0].OwnerId == $owner_id
      and .[0].State == "available"
      and .[0].Architecture == "x86_64"
      and .[0].RootDeviceType == "ebs"
      and .[0].RootDeviceName == "/dev/xvda"
      and .[0].VirtualizationType == "hvm"
      and .[0].ImageType == "machine"
      and .[0].PlatformDetails == "Linux/UNIX"
      and .[0].Public == false
      and .[0].ImdsSupport == "v2.0"
      and (
        (.[0].DeprecationTime // "") == ""
        or (
          .[0].DeprecationTime
          | sub("\\.[0-9]+Z$"; "Z")
          | fromdateiso8601
        ) > now
      )
      and (.[0].BlockDeviceMappings | length == 1)
      and .[0].BlockDeviceMappings[0].DeviceName == "/dev/xvda"
      and .[0].BlockDeviceMappings[0].Ebs != null
      and .[0].BlockDeviceMappings[0].Ebs.DeleteOnTermination == true
      and .[0].BlockDeviceMappings[0].Ebs.VolumeSize <= $root_volume_gb
      and (
        .[0].Name
        | test("^hc-(security-)?base-al2023-x86_64-[0-9]{14}$")
      )
  ' <<<"$approved_ami_json" >/dev/null; then
  echo "AMI가 승인된 AL2023 base 계약을 충족하지 않습니다: ${ami_id}" >&2
  exit 1
fi
ami_name="$(jq -r '.Images[0].Name' <<<"$approved_ami_json")"
ami_owner_id="$(jq -r '.Images[0].OwnerId' <<<"$approved_ami_json")"

subnet_vpc_id="$(aws ec2 describe-subnets \
  --region "$AWS_REGION" \
  --subnet-ids "$SUBNET_ID" \
  --query 'Subnets[0].VpcId' \
  --output text)"
security_group_json="$(aws ec2 describe-security-groups \
  --region "$AWS_REGION" \
  --group-ids "$SECURITY_GROUP_ID" \
  --output json)"
security_group_vpc_id="$(jq -r '.SecurityGroups[0].VpcId' <<<"$security_group_json")"
if [[ "$subnet_vpc_id" != "$security_group_vpc_id" ]]; then
  echo "Subnet과 security group의 VPC가 다릅니다." >&2
  exit 1
fi
if ! jq -e '
  [
    .SecurityGroups[0].IpPermissions[]
    | select(
        .IpProtocol == "-1"
        or (
          .IpProtocol == "tcp"
          and (.FromPort <= 22 and .ToPort >= 22)
        )
      )
  ]
  | length == 0
' <<<"$security_group_json" >/dev/null; then
  echo "Security group에 22번 포트 ingress가 있습니다. SSM 전용 SG를 사용하세요." >&2
  exit 1
fi
for required_port in 80 443; do
  if ! jq -e --argjson port "$required_port" '
    [
      .SecurityGroups[0].IpPermissions[]
      | select(
          .IpProtocol == "-1"
          or (
            .IpProtocol == "tcp"
            and (.FromPort <= $port and .ToPort >= $port)
          )
        )
    ]
    | length > 0
  ' <<<"$security_group_json" >/dev/null; then
    echo "Security group에 ${required_port}/tcp ingress가 없습니다." >&2
    exit 1
  fi
done
if [[ "$LAB_PROFILE" == "terraform" ]] && ! jq -e '
  all(
    .SecurityGroups[0].IpPermissions[];
    .IpProtocol == "tcp" and
    .FromPort == .ToPort and
    (.FromPort == 80 or .FromPort == 443)
  )
' <<<"$security_group_json" >/dev/null; then
  echo "Terraform 전용 security group은 80/443 이외 ingress를 가질 수 없습니다." >&2
  exit 1
fi

ssh-keygen \
  -q \
  -t ed25519 \
  -N '' \
  -C "$deploy_key_title" \
  -f "$private_key_file"
gh repo deploy-key add \
  "${private_key_file}.pub" \
  --repo "$GITHUB_REPOSITORY" \
  --title "$deploy_key_title"
deploy_key_created=true
if ! resolve_created_deploy_key_id; then
  echo "생성한 GitHub Deploy Key의 정확한 ID를 확인하지 못했습니다." >&2
  exit 1
fi
deploy_key_read_only="$(
  gh api "repos/${GITHUB_REPOSITORY}/keys/${deploy_key_id}" \
    --jq '.read_only'
)"
if [[ "$deploy_key_read_only" != "true" ]]; then
  echo "GitHub Deploy Key가 read-only로 등록되지 않았습니다." >&2
  exit 1
fi

jq -n \
  --arg name "$parameter_name" \
  --rawfile value "$private_key_file" \
  --arg key_id "$SSM_KMS_KEY_ID" \
  --arg lab_label "$LAB_LABEL" \
  --arg project_tag "$PROJECT_TAG" \
  '{
    Name: $name,
    Description: ("Temporary " + $lab_label + " EC2 Git bootstrap key"),
    Value: $value,
    Type: "SecureString",
    Tier: "Standard",
    DataType: "text",
    Overwrite: false,
    Tags: [
      {Key: "Project", Value: $project_tag},
      {Key: "Purpose", Value: "EphemeralGitBootstrap"}
    ]
  }
  + if $key_id == "" then {} else {KeyId: $key_id} end' \
  >"$parameter_input_file"
aws ssm put-parameter \
  --region "$AWS_REGION" \
  --cli-input-json "file://${parameter_input_file}" >/dev/null
parameter_created=true
parameter_arn="arn:aws:ssm:${AWS_REGION}:${account_id}:parameter${parameter_name}"

jq -n '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: {Service: "ec2.amazonaws.com"},
    Action: "sts:AssumeRole"
  }]
}' >"$trust_policy_file"
if ! aws iam get-role --role-name "$INSTANCE_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "$INSTANCE_ROLE_NAME" \
    --assume-role-policy-document "file://${trust_policy_file}" >/dev/null
else
  aws iam update-assume-role-policy \
    --role-name "$INSTANCE_ROLE_NAME" \
    --policy-document "file://${trust_policy_file}"
fi

# AmazonSSMManagedInstanceCore also grants ssm:GetParameter on Resource "*".
# Keep the SSM agent channels, but reserve Parameter Store reads for the
# short-lived, exact-resource bootstrap policy below.
jq -n '{
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "SsmInstanceCore",
      Effect: "Allow",
      Action: [
        "ssm:DescribeAssociation",
        "ssm:GetDeployablePatchSnapshotForInstance",
        "ssm:GetDocument",
        "ssm:DescribeDocument",
        "ssm:GetManifest",
        "ssm:ListAssociations",
        "ssm:ListInstanceAssociations",
        "ssm:PutInventory",
        "ssm:PutComplianceItems",
        "ssm:PutConfigurePackageResult",
        "ssm:UpdateAssociationStatus",
        "ssm:UpdateInstanceAssociationStatus",
        "ssm:UpdateInstanceInformation"
      ],
      Resource: "*"
    },
    {
      Sid: "SsmMessageChannels",
      Effect: "Allow",
      Action: [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel"
      ],
      Resource: "*"
    },
    {
      Sid: "LegacyEc2MessageChannels",
      Effect: "Allow",
      Action: [
        "ec2messages:AcknowledgeMessage",
        "ec2messages:DeleteMessage",
        "ec2messages:FailMessage",
        "ec2messages:GetEndpoint",
        "ec2messages:GetMessages",
        "ec2messages:SendReply"
      ],
      Resource: "*"
    }
  ]
}' >"$ssm_core_policy_file"
aws iam put-role-policy \
  --role-name "$INSTANCE_ROLE_NAME" \
  --policy-name "$ssm_core_policy_name" \
  --policy-document "file://${ssm_core_policy_file}"
aws iam detach-role-policy \
  --role-name "$INSTANCE_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore \
  >/dev/null 2>&1 || true
unexpected_attached_policies="$(
  aws iam list-attached-role-policies \
    --role-name "$INSTANCE_ROLE_NAME" \
    --query 'AttachedPolicies[].PolicyArn' \
    --output text
)"
if [[ -n "$unexpected_attached_policies" ]]; then
  echo "전용 EC2 role에 예상하지 못한 managed policy가 연결되어 있습니다:" >&2
  echo "${unexpected_attached_policies}" >&2
  exit 1
fi
unexpected_inline_policies="$(
  aws iam list-role-policies \
    --role-name "$INSTANCE_ROLE_NAME" \
    --output json \
    | jq -r \
      --arg expected "$ssm_core_policy_name" \
      '.PolicyNames[] | select(. != $expected)'
)"
if [[ -n "$unexpected_inline_policies" ]]; then
  echo "전용 EC2 role에 이전 또는 예상하지 못한 inline policy가 있습니다:" >&2
  echo "${unexpected_inline_policies}" >&2
  exit 1
fi

if ! aws iam get-instance-profile \
  --instance-profile-name "$INSTANCE_PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile \
    --instance-profile-name "$INSTANCE_PROFILE_NAME" >/dev/null
fi
profile_roles="$(
  aws iam get-instance-profile \
    --instance-profile-name "$INSTANCE_PROFILE_NAME" \
    --query 'InstanceProfile.Roles[].RoleName' \
    --output text
)"
if [[ -z "$profile_roles" ]]; then
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$INSTANCE_PROFILE_NAME" \
    --role-name "$INSTANCE_ROLE_NAME"
elif [[ "$profile_roles" != "$INSTANCE_ROLE_NAME" ]]; then
  echo "전용 instance profile에 예상하지 못한 role이 연결되어 있습니다: ${profile_roles}" >&2
  exit 1
fi
aws iam wait instance-profile-exists \
  --instance-profile-name "$INSTANCE_PROFILE_NAME"
sleep 10

launch_candidate_instance() {
  aws ec2 run-instances \
    --region "$AWS_REGION" \
    --client-token "$client_token" \
    --image-id "$ami_id" \
    --instance-type "$INSTANCE_TYPE" \
    --subnet-id "$SUBNET_ID" \
    --security-group-ids "$SECURITY_GROUP_ID" \
    --associate-public-ip-address \
    --iam-instance-profile "Name=${INSTANCE_PROFILE_NAME}" \
    --user-data "file://${USER_DATA_FILE}" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1,InstanceMetadataTags=enabled \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${ROOT_VOLUME_GB},\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]" \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=Name,Value=${NAME}},{Key=Project,Value=${PROJECT_TAG}},{Key=Runtime,Value=Native},{Key=Deployment,Value=BlueGreenCandidate},{Key=DeploymentId,Value=${deployment_id}},{Key=NativeSlots,Value=${NATIVE_SLOT_COUNT}},{Key=${PARAMETER_TAG},Value=${parameter_name}},{Key=BaseAmiId,Value=${ami_id}},{Key=BaseAmiName,Value=${ami_name}},{Key=BaseAmiOwner,Value=${ami_owner_id}},{Key=AmiCompliance,Value=Approved}]" \
      "ResourceType=volume,Tags=[{Key=Name,Value=${NAME}-root},{Key=Project,Value=${PROJECT_TAG}},{Key=Deployment,Value=BlueGreenCandidate},{Key=DeploymentId,Value=${deployment_id}},{Key=BaseAmiId,Value=${ami_id}},{Key=AmiCompliance,Value=Approved}]" \
    --query 'Instances[0].InstanceId' \
    --output text
}

# The client token makes retries idempotent if the initial API response is lost.
instance_id=""
run_instances_attempted=true
for _launch_attempt in {1..2}; do
  if instance_id="$(launch_candidate_instance)" \
    && [[ "$instance_id" =~ ^i-[a-f0-9]{8,17}$ ]]; then
    break
  fi
  instance_id=""
  echo "EC2 생성 응답을 확인하지 못해 동일 client token으로 재확인합니다." >&2
done
if [[ ! "$instance_id" =~ ^i-[a-f0-9]{8,17}$ ]]; then
  recover_candidate_instance_id || true
fi
if [[ ! "$instance_id" =~ ^i-[a-f0-9]{8,17}$ ]]; then
  echo "생성된 EC2 instance ID를 확인하지 못했습니다: ${instance_id}" >&2
  exit 1
fi
candidate_verified=false
for _attempt in {1..30}; do
  if candidate_instance_matches_deployment \
    && candidate_image_metadata_matches_deployment; then
    candidate_verified=true
    break
  fi
  sleep 2
done
if [[ "$candidate_verified" != "true" ]]; then
  echo "생성된 EC2가 승인 AMI와 배포 태그 계약을 충족하지 않습니다: ${instance_id}" >&2
  exit 1
fi

# Add the secret-read permission only after EC2 returns the exact candidate ID.
# Even another instance that reuses this dedicated role cannot read this key.
instance_arn="arn:aws:ec2:${AWS_REGION}:${account_id}:instance/${instance_id}"
jq -n \
  --arg parameter_arn "$parameter_arn" \
  --arg source_instance_arn "$instance_arn" \
  --arg kms_key "$SSM_KMS_KEY_ID" \
  --arg kms_via_service "ssm.${AWS_REGION}.amazonaws.com" \
  '{
    Version: "2012-10-17",
    Statement: (
      [
        {
          Sid: "ReadOneEphemeralDeployKeyFromOneInstance",
          Effect: "Allow",
          Action: "ssm:GetParameter",
          Resource: $parameter_arn,
          Condition: {
            ArnEquals: {
              "ec2:SourceInstanceARN": $source_instance_arn
            }
          }
        }
      ]
      + (
        if $kms_key == "" then []
        else [{
          Sid: "DecryptOneEphemeralDeployKey",
          Effect: "Allow",
          Action: "kms:Decrypt",
          Resource: $kms_key,
          Condition: {
            ArnEquals: {
              "ec2:SourceInstanceARN": $source_instance_arn
            },
            StringEquals: {
              "kms:ViaService": $kms_via_service,
              "kms:EncryptionContext:PARAMETER_ARN": $parameter_arn
            }
          }
        }]
        end
      )
    )
  }' >"$inline_policy_file"
aws iam put-role-policy \
  --role-name "$INSTANCE_ROLE_NAME" \
  --policy-name "$inline_policy_name" \
  --policy-document "file://${inline_policy_file}"
inline_policy_created=true

aws ec2 wait instance-status-ok \
  --region "$AWS_REGION" \
  --instance-ids "$instance_id"

if [[ "$ALLOCATE_EIP" == "true" ]]; then
  allocation_id="$(aws ec2 allocate-address \
    --region "$AWS_REGION" \
    --domain vpc \
    --tag-specifications \
      "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${NAME}},{Key=Project,Value=${PROJECT_TAG}},{Key=Deployment,Value=BlueGreenCandidate},{Key=DeploymentId,Value=${deployment_id}}]" \
    --query AllocationId \
    --output text)"
  if [[ ! "$allocation_id" =~ ^eipalloc-[a-f0-9]{8,17}$ ]]; then
    echo "이번 배포가 만든 Elastic IP allocation ID를 확인하지 못했습니다: ${allocation_id}" >&2
    exit 1
  fi
  aws ec2 associate-address \
    --region "$AWS_REGION" \
    --instance-id "$instance_id" \
    --no-allow-reassociation \
    --allocation-id "$allocation_id" >/dev/null
  public_ip="$(aws ec2 describe-addresses \
    --region "$AWS_REGION" \
    --allocation-ids "$allocation_id" \
    --query 'Addresses[0].PublicIp' \
    --output text)"
else
  public_ip="$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)"
fi
if ! is_ipv4_address "$public_ip"; then
  echo "인스턴스의 public IPv4 주소를 확인하지 못했습니다: ${public_ip}" >&2
  exit 1
fi
if [[ -z "$LAB_HOST" ]]; then
  LAB_HOST="${public_ip//./-}.sslip.io"
fi

ssm_online=false
for _attempt in {1..90}; do
  if ! ping_status="$(aws ssm describe-instance-information \
    --region "$AWS_REGION" \
    --filters "Key=InstanceIds,Values=${instance_id}" \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text 2>/dev/null)"; then
    ping_status="Offline"
  fi
  if [[ "$ping_status" == "Online" ]]; then
    ssm_online=true
    break
  fi
  sleep 5
done
if [[ "$ssm_online" != "true" ]]; then
  echo "SSM managed instance가 제한 시간 안에 Online이 되지 않았습니다." >&2
  exit 1
fi

jq -n \
  --arg cloud_ready "$CLOUD_READY" \
  --arg deploy_key_public "$DEPLOY_KEY_PUBLIC" \
  --arg git_ssh_wrapper "$GIT_SSH_WRAPPER" \
  '{commands: [
    "set -euo pipefail",
    "if ! cloud-init status --wait; then cloud-init status --long >&2 || true; tail -n 200 /var/log/cloud-init-output.log >&2 || true; exit 1; fi",
    ("test -f " + $cloud_ready),
    ("test -s " + $deploy_key_public),
    ("test -x " + $git_ssh_wrapper)
  ]}' >"$command_parameters_file"
cloud_init_command_id="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Wait for ${LAB_LABEL} cloud-init" \
  --parameters "file://${command_parameters_file}" \
  --timeout-seconds 1800 \
  --query 'Command.CommandId' \
  --output text)"
wait_for_ssm_command "$cloud_init_command_id" 1800

aws ssm delete-parameter \
  --region "$AWS_REGION" \
  --name "$parameter_name"
parameter_created=false
aws iam delete-role-policy \
  --role-name "$INSTANCE_ROLE_NAME" \
  --policy-name "$inline_policy_name"
inline_policy_created=false

if [[ "$AUTO_INSTALL" == "true" ]]; then
  defer_caddy_start=false
  if [[ -n "$ROUTE53_HOSTED_ZONE_ID" ]]; then
    defer_caddy_start=true
    hosted_zone_json="$(aws route53 get-hosted-zone \
      --id "$ROUTE53_HOSTED_ZONE_ID" \
      --output json)"
    hosted_zone_name="$(jq -r '.HostedZone.Name' <<<"$hosted_zone_json")"
    if [[ "$(jq -r '.HostedZone.Config.PrivateZone' <<<"$hosted_zone_json")" == "true" ]]; then
      echo "공개 HTTPS lab에는 public Route 53 hosted zone이 필요합니다." >&2
      exit 1
    fi
    record_name="${LAB_HOST%.}."
    if [[ "$record_name" != "$hosted_zone_name" \
      && "$record_name" != *".${hosted_zone_name}" ]]; then
      echo "LAB_HOST가 지정한 Route 53 hosted zone에 속하지 않습니다." >&2
      exit 1
    fi

    route53_records="$(
      aws route53 list-resource-record-sets \
        --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
        --start-record-name "$record_name" \
        --start-record-type A \
        --max-items 1
    )"
    jq -e \
      --arg name "$record_name" \
      '.ResourceRecordSets[0]
        | select(.Name == $name and .Type == "A")' \
      <<<"$route53_records" >"$route53_previous_file" || true
    if [[ -s "$route53_previous_file" ]] \
      && jq -e 'has("SetIdentifier")' "$route53_previous_file" >/dev/null; then
      echo "가중치·지연·장애조치 Route 53 레코드는 자동 전환하지 않습니다." >&2
      exit 1
    fi

    if [[ -s "$route53_previous_file" ]]; then
      jq -n \
        --arg name "$record_name" \
        --arg address "$public_ip" \
        --arg lab_label "$LAB_LABEL" \
        --slurpfile previous "$route53_previous_file" \
        'def candidate: {
          Name: $name,
          Type: "A",
          TTL: 60,
          ResourceRecords: [{Value: $address}]
        };
        (if $lab_label == "Vault Lab" then
          {Comment: "Vault Lab blue/green candidate exact cutover"}
        else
          {Comment: ($lab_label + " blue/green candidate exact cutover")}
        end) + {
          Changes: [
            {
              Action: "DELETE",
              ResourceRecordSet: $previous[0]
            },
            {
              Action: "CREATE",
              ResourceRecordSet: candidate
            }
          ]
        }' >"$route53_change_file"
      if jq -e \
        --slurpfile change "$route53_change_file" \
        '. == (
          $change[0].Changes[]
          | select(.Action == "CREATE")
          | .ResourceRecordSet
        )' \
        "$route53_previous_file" >/dev/null; then
        candidate_cleanup_blocked=true
        echo "Route 53은 배포 전부터 후보 IP를 가리킵니다. 실패 시 후보를 보존합니다." >&2
      fi
    else
      jq -n \
        --arg name "$record_name" \
        --arg address "$public_ip" \
        --arg lab_label "$LAB_LABEL" \
        '(if $lab_label == "Vault Lab" then
          {Comment: "Vault Lab blue/green candidate exact create"}
        else
          {Comment: ($lab_label + " blue/green candidate exact create")}
        end) + {
          Changes: [{
            Action: "CREATE",
            ResourceRecordSet: {
              Name: $name,
              Type: "A",
              TTL: 60,
              ResourceRecords: [{Value: $address}]
            }
          }]
        }' >"$route53_change_file"
    fi
  fi

  install_command="$(
    printf '%q ' \
      env \
      GIT_SSH_COMMAND="$GIT_SSH_WRAPPER" \
      git \
      clone \
      --branch "$DEPLOY_BRANCH" \
      --single-branch \
      "$GITHUB_REPOSITORY_SSH" \
      "${APP_ROOT}/repository"
  )"$'\n'"$(
    printf '%q ' \
      env \
      LAB_PROFILE="$LAB_PROFILE" \
      COURSE_ID="$COURSE_ID" \
      LAB_HOST="$LAB_HOST" \
      LAB_LEGACY_HOST="$LAB_LEGACY_HOST" \
      LAB_ADMIN_EMAIL="$LAB_ADMIN_EMAIL" \
      NATIVE_SLOT_COUNT="$NATIVE_SLOT_COUNT" \
      DEPLOY_BRANCH="$DEPLOY_BRANCH" \
      DEFER_CADDY_START="$defer_caddy_start" \
      "${APP_ROOT}/repository/${INSTALL_SCRIPT}"
  )"
  jq -n --arg command "$install_command" \
    '{commands: ["set -euo pipefail", $command]}' \
    >"$command_parameters_file"
  install_command_id="$(aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --document-name AWS-RunShellScript \
    --comment "Install Docker-free ${LAB_LABEL} from read-only Git" \
    --parameters "file://${command_parameters_file}" \
    --timeout-seconds 3600 \
    --query 'Command.CommandId' \
    --output text)"
  wait_for_ssm_command "$install_command_id" 3600

  if [[ "$LAB_PROFILE" == "terraform" ]]; then
    reboot_terraform_candidate_before_cutover
  fi

  if [[ -n "$ROUTE53_HOSTED_ZONE_ID" ]]; then
    if [[ "$candidate_cleanup_blocked" == "true" ]]; then
      echo "Route 53 A record가 이미 후보 public IP를 가리켜 변경을 생략합니다: ${LAB_HOST} -> ${public_ip}"
    else
      dns_change_attempted=true
      route53_change_id="$(aws route53 change-resource-record-sets \
        --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
        --change-batch "file://${route53_change_file}" \
        --query ChangeInfo.Id \
        --output text)"
      dns_changed=true
      aws route53 wait resource-record-sets-changed \
        --id "$route53_change_id"
      echo "Route 53 A record가 후보 public IP로 INSYNC 되었습니다: ${LAB_HOST} -> ${public_ip}"
    fi

    cutover_command="$(
      printf '%q ' \
        env \
        LAB_HOST="$LAB_HOST" \
        LAB_LEGACY_HOST="$LAB_LEGACY_HOST" \
        "${APP_ROOT}/current/${CUTOVER_SCRIPT}"
    )"
    jq -n --arg command "$cutover_command" \
      '{commands: ["set -euo pipefail", $command]}' \
      >"$command_parameters_file"
    cutover_command_id="$(aws ssm send-command \
      --region "$AWS_REGION" \
      --instance-ids "$instance_id" \
      --document-name AWS-RunShellScript \
      --comment "Cut over ${LAB_LABEL} Caddy after Route 53 INSYNC" \
      --parameters "file://${command_parameters_file}" \
      --timeout-seconds 1200 \
      --query 'Command.CommandId' \
      --output text)"
    wait_for_ssm_command "$cutover_command_id" 1200
    # Keep dns_changed=true until the script exits successfully. A later
    # failure must still restore DNS before automatic candidate cleanup.
  fi
fi

echo "AWS account: ${account_id}"
echo "Lab profile: ${LAB_PROFILE}"
echo "Blue/green candidate: ${instance_id}"
echo "Approved base AMI: ${ami_id} (${ami_name}, owner ${ami_owner_id})"
echo "Instance profile: ${INSTANCE_PROFILE_NAME}"
echo "Security group: ${SECURITY_GROUP_ID} (SSH 22 없음)"
echo "Native slots: ${NATIVE_SLOT_COUNT}"
echo "Public IP: ${public_ip}"
echo "HTTPS host: ${LAB_HOST}"
if [[ -n "$allocation_id" ]]; then
  echo "Elastic IP allocation: ${allocation_id}"
fi
echo "GitHub Deploy Key: ${deploy_key_title} (read-only)"
echo "임시 SecureString은 bootstrap 직후 삭제되었습니다."
if [[ "$AUTO_INSTALL" == "true" ]]; then
  echo "네이티브 설치 완료: https://${LAB_HOST}"
else
  echo "SSM으로 Git clone과 ${INSTALL_SCRIPT}를 실행하세요."
fi
