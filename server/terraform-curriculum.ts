import type { Step } from "./curriculum.js";

const TERRAFORM_VERSION = "1.15.8";
const LOCAL_VERSION = "2.5.3";
const RANDOM_VERSION = "3.7.2";
const NULL_VERSION = "3.2.4";
const TLS_VERSION = "4.1.0";

const marker = (id: string) => `verified:${id}`;

const shell = (script: string) => [
  "/bin/sh",
  "-c",
  `set -eu
${script.trim()}`,
];

const enterProject = (directory: string, create: boolean) => `
test -n "\${HOME:-}"
lab_root="$HOME/terraform-lab"
${create ? 'mkdir -p "$lab_root"' : ':'}
test -d "$lab_root"
test ! -L "$lab_root"
project="$lab_root/${directory}"
${create ? 'mkdir -p "$project"' : ':'}
test -d "$project"
test ! -L "$project"
resolved_root="$(realpath -e "$lab_root")"
resolved_project="$(realpath -e "$project")"
case "$resolved_project" in
  "$resolved_root"/*) ;;
  *) exit 1 ;;
esac
cd "$project"
`;

const publicCommand = (directory: string, script: string) => `(
  set -eu
${enterProject(directory, true)}
${script.trim()}
)`;

const verify = (id: string, directory: string, script: string) => shell(`
${enterProject(directory, false)}
${script}
printf '%s\\n' '${marker(id)}'
`);

const verifyGlobal = (id: string, script: string) => shell(`
${script}
printf '%s\\n' '${marker(id)}'
`);

const fixture = (id: string, directory: string, script: string) => shell(`
${enterProject(directory, true)}
find "$resolved_project" -xdev -mindepth 1 -delete
${script}
printf '%s\\n' '${marker(id)}'
`);

const fixtureGlobal = (id: string, script = ":") => shell(`
${script}
printf '%s\\n' '${marker(id)}'
`);

const writeFile = (path: string, content: string) => `cat > '${path}' <<'TFLAB_HCL'
${content.trim()}
TFLAB_HCL`;

const localVersions = `terraform {
  required_version = "= ${TERRAFORM_VERSION}"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "${LOCAL_VERSION}"
    }
  }
}`;

const localRandomVersions = `terraform {
  required_version = "= ${TERRAFORM_VERSION}"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "${LOCAL_VERSION}"
    }
    random = {
      source  = "hashicorp/random"
      version = "${RANDOM_VERSION}"
    }
  }
}`;

const graphVersions = `terraform {
  required_version = "= ${TERRAFORM_VERSION}"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "${LOCAL_VERSION}"
    }
    random = {
      source  = "hashicorp/random"
      version = "${RANDOM_VERSION}"
    }
    null = {
      source  = "hashicorp/null"
      version = "${NULL_VERSION}"
    }
  }
}`;

const securityVersions = `terraform {
  required_version = "= ${TERRAFORM_VERSION}"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "${LOCAL_VERSION}"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "${TLS_VERSION}"
    }
  }
}`;

const workflowMain = `resource "local_file" "welcome" {
  filename        = "\${path.module}/artifacts/welcome.txt"
  content         = "Terraform Lab\\n"
  file_permission = "0600"
}

output "welcome_path" {
  value = local_file.welcome.filename
}`;

const workflowFiles = `
mkdir -p artifacts
test ! -L artifacts
${writeFile("versions.tf", localVersions)}
${writeFile("main.tf", workflowMain)}
terraform fmt -no-color >/dev/null
`;

const workflowInit = `
${workflowFiles}
terraform init -input=false -no-color >/dev/null
terraform validate -no-color >/dev/null
`;

const workflowCleanInit = `
${workflowInit}
rm -f terraform.tfstate terraform.tfstate.backup workflow.tfplan artifacts/welcome.txt
`;

const workflowCreatePlan = `
${workflowCleanInit}
terraform plan -input=false -no-color -out=workflow.tfplan >/dev/null
`;

const workflowApplied = `
${workflowCreatePlan}
terraform apply -input=false -no-color workflow.tfplan >/dev/null
`;

const valuesVariables = `variable "environment" {
  type    = string
  default = "dev"

  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "environment must be dev, stage, or prod."
  }
}

variable "replicas" {
  type    = number
  default = 2

  validation {
    condition     = var.replicas >= 1 && var.replicas <= 5 && floor(var.replicas) == var.replicas
    error_message = "replicas must be an integer from 1 through 5."
  }
}

variable "service_ports" {
  type    = set(number)
  default = [8080, 8443]
}

locals {
  normalized_name = lower("Payments-\${var.environment}")
  sorted_ports = [
    for port in sort([for port in var.service_ports : tostring(port)]) :
    tonumber(port)
  ]
}`;

const valuesOutputs = `output "configuration" {
  value = {
    name     = local.normalized_name
    replicas = var.replicas
    ports    = local.sorted_ports
  }
}`;

const valuesTfvars = `environment   = "stage"
replicas      = 3
service_ports = [8080, 8443]`;

const valuesInventory = `resource "local_file" "inventory" {
  filename = "\${path.module}/artifacts/inventory.json"
  content = jsonencode({
    environment = var.environment
    service     = local.normalized_name
    replicas    = var.replicas
    ports       = local.sorted_ports
  })
  file_permission = "0600"
}`;

const valuesSecrets = `resource "random_password" "api" {
  length           = 24
  special          = true
  override_special = "_-"
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 2
}

resource "local_sensitive_file" "credential" {
  filename = "\${path.module}/artifacts/credential.json"
  content = jsonencode({
    username = "\${local.normalized_name}-svc"
    password = random_password.api.result
  })
  file_permission = "0600"
}

output "api_password" {
  value     = random_password.api.result
  sensitive = true
}`;

const valuesBase = `
mkdir -p artifacts
test ! -L artifacts
${writeFile("versions.tf", localVersions)}
${writeFile("variables.tf", valuesVariables)}
${writeFile("outputs.tf", valuesOutputs)}
rm -f main.tf secrets.tf training.auto.tfvars values.tfplan
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform validate -no-color >/dev/null
`;

const valuesPlanned = `
${valuesBase}
${writeFile("training.auto.tfvars", valuesTfvars)}
terraform fmt -no-color >/dev/null
terraform plan -input=false -no-color -out=values.tfplan >/dev/null
`;

const valuesRendered = `
${valuesPlanned}
${writeFile("main.tf", valuesInventory)}
terraform fmt -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const valuesSensitive = `
${valuesRendered}
${writeFile("versions.tf", localRandomVersions)}
${writeFile("secrets.tf", valuesSecrets)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const stateMain = `resource "local_file" "managed" {
  filename        = "\${path.module}/artifacts/service.txt"
  content         = "managed by Terraform\\n"
  file_permission = "0600"
}`;

const stateApplied = `
mkdir -p artifacts
test ! -L artifacts
${writeFile("versions.tf", localVersions)}
${writeFile("main.tf", stateMain)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const stateInspected = `
${stateApplied}
terraform state list > artifacts/state-list.txt
terraform state show -no-color local_file.managed > artifacts/state-show.txt
`;

const stateDrifted = `
${stateInspected}
printf '%s\\n' 'manual drift' > artifacts/service.txt
set +e
terraform plan -input=false -no-color -detailed-exitcode -out=drift.tfplan >/dev/null
plan_status=$?
set -e
test "$plan_status" -eq 2
`;

const stateReconciled = `
${stateDrifted}
terraform show -json drift.tfplan | jq -e '
  [.resource_drift[]?] as $drift |
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($drift | length) == 1 and
  $drift[0].mode == "managed" and
  $drift[0].address == "local_file.managed" and
  $drift[0].change.actions == ["delete"] and
  ($managed | length) == 1 and
  $managed[0].address == "local_file.managed" and
  $managed[0].change.actions == ["create"]
' >/dev/null
drift_before_filename="$(terraform show -json drift.tfplan |
  jq -er '.resource_drift[] | select(.address == "local_file.managed") | .change.before.filename')"
drift_after_filename="$(terraform show -json drift.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.managed") | .change.after.filename')"
test "$(realpath -m -- "$drift_before_filename")" = \
  "$resolved_project/artifacts/service.txt"
test "$(realpath -m -- "$drift_after_filename")" = \
  "$resolved_project/artifacts/service.txt"
terraform apply -input=false -no-color drift.tfplan >/dev/null
`;

const disposableMain = `resource "local_file" "disposable" {
  filename        = "\${path.module}/artifacts/disposable.txt"
  content         = "safe destroy demo\\n"
  file_permission = "0600"
}`;

const backupDestroy = `
mkdir -p artifacts
test ! -L artifacts
${writeFile("versions.tf", localVersions)}
${writeFile("main.tf", disposableMain)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform plan -input=false -no-color -out=create.tfplan >/dev/null
terraform show -json create.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.disposable" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  $managed[0].change.after.content == "safe destroy demo\\n"
' >/dev/null
create_filename="$(terraform show -json create.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.disposable") | .change.after.filename')"
test "$(realpath -m -- "$create_filename")" = \
  "$resolved_project/artifacts/disposable.txt"
terraform apply -input=false -no-color create.tfplan >/dev/null
umask 077
terraform state pull > artifacts/pre-destroy.tfstate.json
sha256sum artifacts/pre-destroy.tfstate.json > artifacts/pre-destroy.tfstate.json.sha256
terraform plan -destroy -input=false -no-color -out=destroy.tfplan >/dev/null
terraform show -json destroy.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.disposable" and
  $managed[0].change.actions == ["delete"]
' >/dev/null
destroy_filename="$(terraform show -json destroy.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.disposable") | .change.before.filename')"
test "$(realpath -m -- "$destroy_filename")" = \
  "$resolved_project/artifacts/disposable.txt"
terraform apply -input=false -no-color destroy.tfplan >/dev/null
`;

const graphMain = `locals {
  services = {
    api    = 8080
    web    = 8081
    worker = 9090
  }
}

resource "local_file" "service" {
  for_each = local.services

  filename = "\${path.module}/artifacts/\${each.key}.json"
  content = jsonencode({
    name = each.key
    port = each.value
  })
  file_permission = "0600"
}`;

const graphRandom = `resource "random_id" "node" {
  count       = 3
  byte_length = 4

  keepers = {
    slot = tostring(count.index)
  }
}

output "node_ids" {
  value = random_id.node[*].hex
}`;

const graphDependency = `resource "null_resource" "manifest_gate" {
  triggers = {
    contract = "all-service-files-ready"
  }

  depends_on = [local_file.service]
}`;

const graphBase = `
mkdir -p artifacts
test ! -L artifacts
${writeFile("versions.tf", localVersions)}
${writeFile("main.tf", graphMain)}
rm -f random.tf dependency.tf
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const graphCounted = `
${graphBase}
${writeFile("versions.tf", localRandomVersions)}
${writeFile("random.tf", graphRandom)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const graphDependent = `
${graphCounted}
${writeFile("versions.tf", graphVersions)}
${writeFile("dependency.tf", graphDependency)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const moduleVersions = localVersions;

const moduleVariables = `variable "name" {
  type = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "name must be a lowercase service name."
  }
}

variable "content" {
  type = string
}

variable "output_dir" {
  type = string
}`;

const moduleResource = `resource "local_file" "this" {
  filename        = "\${var.output_dir}/\${var.name}.txt"
  content         = "\${var.content}\\n"
  file_permission = "0600"
}`;

const moduleOutput = `output "path" {
  value = local_file.this.filename
}`;

const moduleRoot = `locals {
  components = {
    backend  = "api"
    frontend = "ui"
  }
}

module "artifact" {
  for_each = local.components
  source   = "./modules/artifact"

  name       = each.key
  content    = each.value
  output_dir = "\${path.root}/artifacts"
}

output "artifact_paths" {
  value = {
    for name, artifact in module.artifact : name => artifact.path
  }
}`;

const moduleTest = `run "module_contract" {
  command = plan

  assert {
    condition     = length(output.artifact_paths) == 2
    error_message = "Exactly two artifacts are required."
  }

  assert {
    condition = alltrue([
      for name, path in output.artifact_paths :
      endswith(path, "/\${name}.txt")
    ])
    error_message = "Every artifact path must match its module key."
  }
}`;

const movedModuleResource = `moved {
  from = local_file.this
  to   = local_file.artifact
}

resource "local_file" "artifact" {
  filename        = "\${var.output_dir}/\${var.name}.txt"
  content         = "\${var.content}\\n"
  file_permission = "0600"
}`;

const movedModuleOutput = `output "path" {
  value = local_file.artifact.filename
}`;

const moduleContract = `
mkdir -p modules/artifact artifacts tests
test ! -L modules
test ! -L modules/artifact
test ! -L artifacts
test ! -L tests
${writeFile("modules/artifact/versions.tf", moduleVersions)}
${writeFile("modules/artifact/variables.tf", moduleVariables)}
${writeFile("modules/artifact/main.tf", moduleResource)}
${writeFile("modules/artifact/outputs.tf", moduleOutput)}
terraform fmt -recursive -no-color >/dev/null
terraform -chdir=modules/artifact init -backend=false -input=false -no-color >/dev/null
terraform -chdir=modules/artifact validate -no-color >/dev/null
`;

const moduleCalled = `
${moduleContract}
${writeFile("versions.tf", localVersions)}
${writeFile("main.tf", moduleRoot)}
terraform fmt -recursive -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const moduleOutputWritten = `
${moduleCalled}
terraform output -json artifact_paths | jq -S . > artifacts/module-outputs.json
`;

const moduleTested = `
${moduleCalled}
${writeFile("tests/artifact.tftest.hcl", moduleTest)}
terraform fmt -recursive -no-color >/dev/null
terraform test -no-color > artifacts/test-results.txt
`;

const moduleMoved = `
${moduleCalled}
${writeFile("modules/artifact/main.tf", movedModuleResource)}
${writeFile("modules/artifact/outputs.tf", movedModuleOutput)}
terraform fmt -recursive -no-color >/dev/null
terraform plan -input=false -no-color -out=refactor.tfplan >/dev/null
terraform show -json refactor.tfplan | jq -e '
  [.resource_changes[]? |
    select(.mode == "managed") |
    .change.actions[] |
    select(. != "no-op")] |
  length == 0
' >/dev/null
terraform apply -input=false -no-color refactor.tfplan >/dev/null
`;

const securityMain = `resource "tls_private_key" "learner" {
  algorithm = "ED25519"
}

resource "local_sensitive_file" "private_key" {
  filename        = "\${path.module}/artifacts/learner-key"
  content         = tls_private_key.learner.private_key_openssh
  file_permission = "0600"
}

resource "local_file" "public_key" {
  filename        = "\${path.module}/artifacts/learner-key.pub"
  content         = "\${chomp(tls_private_key.learner.public_key_openssh)} terraform-lab\\n"
  file_permission = "0600"
}

output "public_key_fingerprint" {
  value = tls_private_key.learner.public_key_fingerprint_sha256
}`;

const securityCheckedMain = `variable "key_algorithm" {
  type    = string
  default = "ED25519"

  validation {
    condition     = var.key_algorithm == "ED25519"
    error_message = "key_algorithm must be ED25519."
  }
}

resource "tls_private_key" "learner" {
  algorithm = var.key_algorithm
}

resource "local_sensitive_file" "private_key" {
  filename        = "\${path.module}/artifacts/learner-key"
  content         = tls_private_key.learner.private_key_openssh
  file_permission = "0600"
}

resource "local_file" "public_key" {
  filename        = "\${path.module}/artifacts/learner-key.pub"
  content         = "\${chomp(tls_private_key.learner.public_key_openssh)} terraform-lab\\n"
  file_permission = "0600"
}

check "secure_private_key_file" {
  assert {
    condition     = local_sensitive_file.private_key.file_permission == "0600"
    error_message = "Private key files must use mode 0600."
  }
}

output "public_key_fingerprint" {
  value = tls_private_key.learner.public_key_fingerprint_sha256
}`;

const securityApplied = `
mkdir -p artifacts
test ! -L artifacts
${writeFile("versions.tf", securityVersions)}
${writeFile("main.tf", securityMain)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform apply -input=false -auto-approve -no-color >/dev/null
`;

const securityAudited = `
${securityApplied}
terraform show -json | jq -e '
  .values.root_module.resources[] |
  select(.address == "tls_private_key.learner") |
  .sensitive_values.private_key_openssh == true
' >/dev/null
jq -n '{
  state_contains_sensitive_values: true,
  mitigation: "encrypted remote backend + restricted access"
}' > artifacts/sensitive-audit.json
`;

const securityChecked = `
${securityApplied}
${writeFile("main.tf", securityCheckedMain)}
terraform fmt -no-color >/dev/null
terraform plan -input=false -no-color -out=security.tfplan >/dev/null
if terraform plan -input=false -no-color -var=key_algorithm=DES > artifacts/rejected-plan.txt 2>&1; then
  exit 1
fi
grep -F 'key_algorithm must be ED25519.' artifacts/rejected-plan.txt >/dev/null
`;

const operationsMain = `variable "release_version" {
  type    = string
  default = "v1"

  validation {
    condition     = can(regex("^v[0-9]+$", var.release_version))
    error_message = "release_version must look like v1."
  }
}

resource "local_file" "release" {
  filename = "\${path.module}/artifacts/\${terraform.workspace}/release.json"
  content = jsonencode({
    workspace = terraform.workspace
    version   = var.release_version
  })
  file_permission = "0600"
}

output "release_path" {
  value = local_file.release.filename
}`;

const operationsApplied = `
mkdir -p artifacts
test ! -L artifacts
${writeFile("versions.tf", localVersions)}
${writeFile("main.tf", operationsMain)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform workspace select stage >/dev/null 2>&1 || terraform workspace new stage >/dev/null
mkdir -p artifacts/stage
test ! -L artifacts/stage
terraform plan -input=false -no-color -out=stage.tfplan >/dev/null
terraform show -json stage.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  ($managed[0].change.after.content | fromjson) == {
    "version": "v1",
    "workspace": "stage"
  }
' >/dev/null
stage_filename="$(terraform show -json stage.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.after.filename')"
test "$(realpath -m -- "$stage_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform apply -input=false -no-color stage.tfplan >/dev/null
`;

const operationsReplaced = `
${operationsApplied}
terraform plan -input=false -no-color -replace=local_file.release -out=replace.tfplan >/dev/null
terraform show -json replace.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["delete", "create"]
' >/dev/null
replace_before_filename="$(terraform show -json replace.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.before.filename')"
replace_after_filename="$(terraform show -json replace.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.after.filename')"
test "$(realpath -m -- "$replace_before_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
test "$(realpath -m -- "$replace_after_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform show -json replace.tfplan | jq -S '
  .resource_changes[] |
  select(.address == "local_file.release") |
  {address, actions: .change.actions}
' > artifacts/replacement-proof.json
terraform apply -input=false -no-color replace.tfplan >/dev/null
`;

const operationsRefreshed = `
${operationsReplaced}
printf '%s\\n' '{"workspace":"stage","version":"manual-drift"}' > artifacts/stage/release.json
terraform plan -refresh-only -input=false -no-color -out=refresh-only.tfplan >/dev/null
terraform show -json refresh-only.tfplan | jq -e '
  [.resource_drift[]?] as $drift |
  ($drift | length) == 1 and
  $drift[0].mode == "managed" and
  $drift[0].address == "local_file.release" and
  $drift[0].change.actions == ["delete"]
' >/dev/null
refresh_filename="$(terraform show -json refresh-only.tfplan |
  jq -er '.resource_drift[] | select(.address == "local_file.release") | .change.before.filename')"
test "$(realpath -m -- "$refresh_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform apply -input=false -no-color refresh-only.tfplan >/dev/null
`;

const operationsDestroyed = `
${operationsRefreshed}
terraform plan -input=false -no-color -out=recreate.tfplan >/dev/null
terraform show -json recreate.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  ($managed[0].change.after.content | fromjson) == {
    "version": "v1",
    "workspace": "stage"
  }
' >/dev/null
recreate_filename="$(terraform show -json recreate.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.after.filename')"
test "$(realpath -m -- "$recreate_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform apply -input=false -no-color recreate.tfplan >/dev/null
terraform plan -destroy -input=false -no-color -out=safe-destroy.tfplan >/dev/null
terraform show -json safe-destroy.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["delete"]
' >/dev/null
safe_destroy_filename="$(terraform show -json safe-destroy.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.before.filename')"
test "$(realpath -m -- "$safe_destroy_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform apply -input=false -no-color safe-destroy.tfplan >/dev/null
`;

const AGENT_SKILLS_ROOT = "/opt/terraform-lab/agent-skills";
const AGENT_SKILLS_REPOSITORY = "https://github.com/hashicorp/agent-skills";
const AGENT_SKILLS_COMMIT = "4451ceca5456e79cc776efee96a744f7ac96e5bf";
const AGENT_SKILL_CAPABILITIES = [
  { name: "azure-verified-modules", category: "module", capability: "Azure Verified Modules 인증 요구사항을 Terraform module에 적용합니다.", use_when: "Azure module을 AVM 규격으로 설계하거나 인증 준비를 할 때" },
  { name: "new-terraform-provider", category: "provider", capability: "Terraform Plugin Framework 기반의 새 Provider 골격과 개발 흐름을 안내합니다.", use_when: "새 API용 Terraform Provider 프로젝트를 시작할 때" },
  { name: "provider-actions", category: "provider", capability: "리소스 수명주기 전후의 명령형 Provider Action 구현을 안내합니다.", use_when: "CRUD 외 백업·재시작 같은 명령형 작업을 Provider에 추가할 때" },
  { name: "provider-configuration", category: "provider", capability: "Provider 인증 스키마, 환경변수 fallback과 credential chain을 설계합니다.", use_when: "Provider의 안전한 인증과 설정 로딩을 구현할 때" },
  { name: "provider-docs", category: "provider", capability: "tfplugindocs 기반 Registry 문서를 생성하고 품질을 검토합니다.", use_when: "Provider·resource·data source 문서를 배포할 때" },
  { name: "provider-ephemeral-resources", category: "provider", capability: "State에 남기지 않는 토큰·인증서용 ephemeral resource를 구현합니다.", use_when: "짧게 유지해야 하는 민감 값을 Provider에서 다룰 때" },
  { name: "provider-framework-migration", category: "provider", capability: "SDKv2 Provider를 Plugin Framework로 점진적으로 전환합니다.", use_when: "기존 Provider를 중단 없이 현대화할 때" },
  { name: "provider-resources", category: "provider", capability: "Resource와 data source의 schema, CRUD, import와 drift 처리를 설계합니다.", use_when: "Provider 리소스 동작을 새로 만들거나 검토할 때" },
  { name: "provider-test-patterns", category: "provider", capability: "Plugin Framework Provider의 acceptance test 패턴을 적용합니다.", use_when: "Provider 회귀·상태·import 동작을 자동 검증할 때" },
  { name: "refactor-module", category: "module", capability: "단일 Terraform 구성을 재사용 가능한 module로 안전하게 리팩터링합니다.", use_when: "기존 state 주소를 보존하며 module 경계를 만들 때" },
  { name: "run-acceptance-tests", category: "provider", capability: "TestAcc 테스트 실행, 필수 환경변수와 실패 원인 진단을 안내합니다.", use_when: "Provider acceptance test를 실제 API에 대해 실행할 때" },
  { name: "terraform-policy", category: "policy", capability: "Terraform policy와 policy test 작성 및 Sentinel 변환을 안내합니다.", use_when: "IaC 규칙을 코드화하고 정책 테스트로 검증할 때" },
  { name: "terraform-search-import", category: "import", capability: "Terraform Search로 기존 리소스를 찾고 일괄 import하는 절차를 안내합니다.", use_when: "이미 존재하는 인프라를 Terraform 관리로 편입할 때" },
  { name: "terraform-stacks", category: "stacks", capability: "component와 deployment 구성으로 Terraform Stacks를 설계합니다.", use_when: "여러 배포 단위와 환경을 Stacks로 오케스트레이션할 때" },
  { name: "terraform-style-guide", category: "configuration", capability: "HashiCorp 권장 HCL 파일 구성, 이름과 표현 스타일을 적용합니다.", use_when: "Terraform 구성을 작성하거나 코드 리뷰할 때" },
  { name: "terraform-test", category: "test", capability: "tftest.hcl의 run, assertion과 mock provider 기반 테스트를 작성합니다.", use_when: "module과 configuration의 동작 계약을 자동 검증할 때" },
] as const;
const AGENT_SKILL_NAMES = AGENT_SKILL_CAPABILITIES.map(({ name }) => name);
const agentSkillCapabilitiesJson = JSON.stringify({
  source_repository: AGENT_SKILLS_REPOSITORY,
  source_commit: AGENT_SKILLS_COMMIT,
  source_kind: "unreleased-main-snapshot",
  agent_execution: "not-run-in-this-offline-lab",
  skills: AGENT_SKILL_CAPABILITIES,
}, null, 2);

const agentSkillsSnapshotVerified = `
snapshot_root='${AGENT_SKILLS_ROOT}'
test -d "$snapshot_root"
test ! -L "$snapshot_root"
test "$(stat -c '%u:%g:%a' "$snapshot_root")" = "0:0:555"
test -f "$snapshot_root/.upstream-commit"
test ! -L "$snapshot_root/.upstream-commit"
test "$(stat -c '%u:%g:%a' "$snapshot_root/.upstream-commit")" = "0:0:444"
test "$(cat "$snapshot_root/.upstream-commit")" = '${AGENT_SKILLS_COMMIT}'
test -f "$snapshot_root/manifest.sha256"
test ! -L "$snapshot_root/manifest.sha256"
test "$(stat -c '%u:%g:%a' "$snapshot_root/manifest.sha256")" = "0:0:444"
(cd "$snapshot_root" && sha256sum -c manifest.sha256 >/dev/null)
test -z "$(find "$snapshot_root" -type l -print -quit)"
test -z "$(find "$snapshot_root" ! -user root -print -quit)"
test -z "$(find "$snapshot_root" -type d ! -perm 0555 -print -quit)"
test -z "$(find "$snapshot_root" -type f ! -perm 0444 -print -quit)"
manifest_inventory="$(
  sed -En 's|^[[:xdigit:]]{64}  [.]/||p' \
    "$snapshot_root/manifest.sha256" | LC_ALL=C sort
)"
actual_snapshot_inventory="$(
  find "$snapshot_root" -type f \
    ! -path "$snapshot_root/manifest.sha256" \
    -printf '%P\n' | LC_ALL=C sort
)"
test "$manifest_inventory" = "$actual_snapshot_inventory"
test -f "$snapshot_root/LICENSE"
grep -Fq 'Mozilla Public License Version 2.0' "$snapshot_root/LICENSE"
test -f "$snapshot_root/.agents/plugins/marketplace.json"
test -f "$snapshot_root/plugins/terraform/.codex-plugin/plugin.json"
expected_agent_skill_names='${AGENT_SKILL_NAMES.join("\n")}'
actual_agent_skill_names="$(
  find "$snapshot_root/plugins/terraform/skills" \
    -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; | LC_ALL=C sort
)"
test "$actual_agent_skill_names" = "$expected_agent_skill_names"
printf '%s\n' "$actual_agent_skill_names" | while IFS= read -r agent_skill; do
  skill_file="$snapshot_root/plugins/terraform/skills/$agent_skill/SKILL.md"
  test -f "$skill_file"
  test ! -L "$skill_file"
  grep -Fqx "name: $agent_skill" "$skill_file"
  grep -Fq 'lifecycle-status: active' "$skill_file"
done
`;

const agentSkillsCatalogReady = `
${agentSkillsSnapshotVerified}
mkdir -p artifacts
test ! -L artifacts
printf '%s\n' "$actual_agent_skill_names" > artifacts/terraform-skills.txt
jq -Rn '[inputs]' < artifacts/terraform-skills.txt \
  > artifacts/terraform-skills.json
${writeFile("artifacts/skill-capabilities.json", agentSkillCapabilitiesJson)}
jq -e '
  .source_kind == "unreleased-main-snapshot" and
  .agent_execution == "not-run-in-this-offline-lab" and
  (.skills | length) == 16 and
  ([.skills[].name] == $expected) and
  ([.skills[] | select(
    (.capability | type) != "string" or (.capability | length) < 20 or
    (.use_when | type) != "string" or (.use_when | length) < 15
  )] | length) == 0
' --argjson expected "$(jq -c . artifacts/terraform-skills.json)" \
  artifacts/skill-capabilities.json >/dev/null
jq -n \
  --arg repository '${AGENT_SKILLS_REPOSITORY}' \
  --arg commit '${AGENT_SKILLS_COMMIT}' \
  --slurpfile skills artifacts/terraform-skills.json \
  '{
    repository: $repository,
    commit: $commit,
    source_kind: "unreleased-main-snapshot",
    product: "terraform",
    lifecycle: "active",
    skill_count: ($skills[0] | length),
    agent_execution: "not-run-in-this-offline-lab",
    capabilities_file: "artifacts/skill-capabilities.json",
    skills: $skills[0]
  }' > artifacts/catalog-summary.json
`;

const agentSkillsSelectionJson = `{
  "skills": [
    {
      "name": "refactor-module",
      "installation_path": "plugins/terraform/skills/refactor-module",
      "purpose": "module boundary and state-preserving refactor guidance"
    },
    {
      "name": "terraform-style-guide",
      "installation_path": "plugins/terraform/skills/terraform-style-guide",
      "purpose": "official HCL layout and style guidance"
    },
    {
      "name": "terraform-test",
      "installation_path": "plugins/terraform/skills/terraform-test",
      "purpose": "native tftest.hcl scenarios and assertions"
    }
  ]
}`;

const agentSkillsSelectionReady = `
${agentSkillsCatalogReady}
${writeFile("selection.json", agentSkillsSelectionJson)}
jq -e '
  [.skills[].name] == [
    "refactor-module",
    "terraform-style-guide",
    "terraform-test"
  ] and
  ([.skills[].installation_path] | all(
    startswith("plugins/terraform/skills/")
  ))
' selection.json >/dev/null
jq -r '.skills[] | [.name, .purpose] | @tsv' selection.json \
  > artifacts/selection-report.tsv
jq -r '.skills[].name' selection.json | while IFS= read -r agent_skill; do
  source_skill="$snapshot_root/plugins/terraform/skills/$agent_skill"
  test -d "$source_skill"
  test ! -L "$source_skill"
  test -f "$source_skill/SKILL.md"
done
`;

const agentSkillsInstallReady = `
${agentSkillsSelectionReady}
if test -e .agents; then
  test -d .agents
  test ! -L .agents
else
  mkdir .agents
fi
if test -e .agents/skills; then
  test -d .agents/skills
  test ! -L .agents/skills
  find .agents/skills -xdev -mindepth 1 -delete
else
  mkdir .agents/skills
fi
jq -r '.skills[].name' selection.json | while IFS= read -r agent_skill; do
  source_skill="$snapshot_root/plugins/terraform/skills/$agent_skill"
  destination_skill=".agents/skills/$agent_skill"
  mkdir "$destination_skill"
  cp -R "$source_skill"/. "$destination_skill"/
done
test -z "$(find .agents/skills -type l -print -quit)"
find .agents -type d -exec chmod 0700 {} +
find .agents -type f -exec chmod 0600 {} +
find .agents/skills -type f -print0 \
  | LC_ALL=C sort -z \
  | xargs -0 sha256sum > artifacts/installed-skills.sha256
sha256sum -c artifacts/installed-skills.sha256 >/dev/null
jq -n \
  --arg source_repository '${AGENT_SKILLS_REPOSITORY}' \
  --arg source_commit '${AGENT_SKILLS_COMMIT}' \
  --slurpfile selection selection.json \
  '{
    source_repository: $source_repository,
    source_commit: $source_commit,
    source_kind: "unreleased-main-snapshot",
    install_scope: "project",
    install_root: ".agents/skills",
    compatible_agent_discovery: true,
    agent_invoked_in_lab: false,
    skills: [$selection[0].skills[].name]
  }' > artifacts/installation.json
`;

const agentSkillsInstallVerified = `
${agentSkillsSnapshotVerified}
test -f selection.json
jq -e '
  [.skills[].name] == [
    "refactor-module",
    "terraform-style-guide",
    "terraform-test"
  ] and
  [.skills[].installation_path] == [
    "plugins/terraform/skills/refactor-module",
    "plugins/terraform/skills/terraform-style-guide",
    "plugins/terraform/skills/terraform-test"
  ]
' selection.json >/dev/null
test -d .agents/skills
test ! -L .agents
test ! -L .agents/skills
test -z "$(find .agents/skills -type l -print -quit)"
expected_installed_names="$(jq -r '.skills[].name' selection.json | LC_ALL=C sort)"
actual_installed_names="$(
  find .agents/skills -mindepth 1 -maxdepth 1 -type d \
    -exec basename {} \\; | LC_ALL=C sort
)"
test "$actual_installed_names" = "$expected_installed_names"
printf '%s\n' "$actual_installed_names" | while IFS= read -r agent_skill; do
  source_skill="$snapshot_root/plugins/terraform/skills/$agent_skill"
  destination_skill=".agents/skills/$agent_skill"
  test -d "$destination_skill"
  test ! -L "$destination_skill"
  diff -r "$source_skill" "$destination_skill" >/dev/null
done
test -z "$(find .agents -type f -perm /077 -print -quit)"
test -s artifacts/installed-skills.sha256
installed_manifest_inventory="$(
  sed -En 's|^[[:xdigit:]]{64}  ||p' \
    artifacts/installed-skills.sha256 | LC_ALL=C sort
)"
actual_installed_inventory="$(
  find .agents/skills -type f -printf '%p\n' | LC_ALL=C sort
)"
test "$installed_manifest_inventory" = "$actual_installed_inventory"
sha256sum -c artifacts/installed-skills.sha256 >/dev/null
jq -e '
  .source_repository == "${AGENT_SKILLS_REPOSITORY}" and
  .source_commit == "${AGENT_SKILLS_COMMIT}" and
  .source_kind == "unreleased-main-snapshot" and
  .install_scope == "project" and
  .install_root == ".agents/skills" and
  .compatible_agent_discovery == true and
  .agent_invoked_in_lab == false and
  .skills == [
    "refactor-module",
    "terraform-style-guide",
    "terraform-test"
  ]
' artifacts/installation.json >/dev/null
`;

const agentGuidedVariables = `variable "environment" {
  description = "Deployment environment written to the review artifact."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "environment must be dev, stage, or prod."
  }
}`;

const agentGuidedMain = `locals {
  review = {
    environment = var.environment
    managed_by  = "Terraform Agent Skills"
  }
}

resource "local_file" "agent_review" {
  filename        = "\${path.module}/artifacts/\${var.environment}-agent-review.json"
  content         = jsonencode(local.review)
  file_permission = "0600"
}`;

const agentGuidedOutputs = `output "review_path" {
  description = "Path of the generated Agent Skills review artifact."
  value       = local_file.agent_review.filename
}`;

const agentGuidedTest = `run "agent_guided_contract" {
  command = plan

  variables {
    environment = "stage"
  }

  assert {
    condition     = local_file.agent_review.file_permission == "0600"
    error_message = "The review artifact must use mode 0600."
  }

  assert {
    condition     = jsondecode(local_file.agent_review.content).managed_by == "Terraform Agent Skills"
    error_message = "The review artifact must record its guidance source."
  }
}`;

const agentSkillsGuidedTestReady = `
${agentSkillsInstallReady}
mkdir -p tests artifacts
test ! -L tests
test ! -L artifacts
${writeFile("versions.tf", localVersions)}
${writeFile("variables.tf", agentGuidedVariables)}
${writeFile("main.tf", agentGuidedMain)}
${writeFile("outputs.tf", agentGuidedOutputs)}
${writeFile("tests/agent-guided.tftest.hcl", agentGuidedTest)}
terraform fmt -no-color >/dev/null
terraform init -input=false -no-color >/dev/null
terraform validate -no-color >/dev/null
terraform test -no-color > artifacts/terraform-test.txt
jq -n \
  --arg source_commit '${AGENT_SKILLS_COMMIT}' \
  --arg style_skill 'terraform-style-guide' \
  --arg test_skill 'terraform-test' \
  '{
    source_commit: $source_commit,
    guidance: [$style_skill, $test_skill],
    execution_mode: "offline-reference-fixture",
    agent_invoked: false,
    format_check: "passed",
    validation: "passed",
    terraform_test: "passed"
  }' > artifacts/guided-review.json
`;

export const terraformSteps: Step[] = [
  {
    id: "tf-version",
    lab: 1,
    title: "Terraform CLI와 격리 환경 확인",
    objective: "실습에서 사용하는 Terraform 버전과 실행 플랫폼을 확인합니다.",
    description: "고정된 Terraform CLI가 네이티브 Linux 환경에서 실행되는지 조사하세요.",
    concept: "재현 가능한 IaC 실행은 CLI와 provider 버전을 고정하는 것에서 시작합니다. 이 과정은 Docker 없이 승인된 EC2에서 동작합니다.",
    command: "terraform version -json | jq '{terraform_version, platform}'",
    expected: `terraform_version ${TERRAFORM_VERSION} · platform linux_amd64`,
    hint: "사람이 읽는 version 출력 대신 JSON의 두 필드를 확인하세요.",
    troubleshooting: ["terraform: command not found라면 실습 환경 준비가 끝났는지 확인하세요.", "버전이 다르면 개인 바이너리가 PATH 앞에 놓이지 않았는지 확인하세요."],
    success: "고정된 Terraform CLI와 Linux 플랫폼을 확인했습니다.",
    validate: verifyGlobal("tf-version", `
test "$(terraform version -json | jq -r '.terraform_version')" = "${TERRAFORM_VERSION}"
test "$(terraform version -json | jq -r '.platform')" = "linux_amd64"
`),
    expect: [marker("tf-version")],
    skipSetup: fixtureGlobal("tf-version"),
  },
  {
    id: "local-init",
    lab: 1,
    title: "첫 provider와 resource 초기화",
    objective: "정확히 pin한 local provider로 프로젝트를 초기화하고 구성 문법을 검증합니다.",
    description: "local_file 하나와 비민감 output을 선언한 뒤 fmt, init, validate를 실행하세요.",
    concept: "init은 provider를 준비하고 lock file을 만듭니다. 이 랩은 root-owned offline mirror만 사용합니다.",
    command: publicCommand("01-workflow", `${workflowFiles}
terraform init -input=false -no-color
terraform validate -no-color`),
    expected: `Terraform ${TERRAFORM_VERSION} · hashicorp/local ${LOCAL_VERSION} · Success! The configuration is valid.`,
    hint: "init과 validate를 분리해 어느 단계에서 실패했는지 확인하세요.",
    troubleshooting: ["provider 설치 오류는 offline mirror 상태를 확인하세요.", "HCL 오류가 나면 terraform fmt 후 줄 번호를 다시 확인하세요."],
    success: "첫 Terraform 프로젝트와 provider lock을 안전하게 준비했습니다.",
    validate: verify("local-init", "01-workflow", `
terraform fmt -check -no-color >/dev/null
terraform validate -no-color >/dev/null
grep -F 'version = "${LOCAL_VERSION}"' versions.tf >/dev/null
test -s .terraform.lock.hcl
test -z "$(terraform state list 2>/dev/null)"
test ! -e artifacts/welcome.txt
validation_dir="$(mktemp -d)"
trap 'find "$validation_dir" -xdev -mindepth 1 -delete; rmdir "$validation_dir"' EXIT HUP INT TERM
terraform plan -input=false -no-color -out="$validation_dir/local-init.tfplan" >/dev/null
terraform show -json "$validation_dir/local-init.tfplan" | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.welcome" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  $managed[0].change.after.content == "Terraform Lab\\n"
' >/dev/null
planned_filename="$(terraform show -json "$validation_dir/local-init.tfplan" |
  jq -er '.resource_changes[] | select(.address == "local_file.welcome") | .change.after.filename')"
test "$(realpath -m -- "$planned_filename")" = \
  "$resolved_project/artifacts/welcome.txt"
`),
    expect: [marker("local-init")],
    skipSetup: fixture("local-init", "01-workflow", workflowCleanInit),
  },
  {
    id: "saved-plan",
    lab: 1,
    title: "저장된 실행 계획 검토",
    objective: "plan을 파일로 저장하고 JSON에서 정확한 변경 대상을 식별합니다.",
    description: "welcome 파일을 만드는 실행 계획을 workflow.tfplan으로 저장하세요.",
    concept: "저장된 plan은 검토한 변경과 실제 apply 사이의 계약입니다.",
    command: publicCommand("01-workflow", "terraform plan -input=false -no-color -out=workflow.tfplan"),
    expected: "local_file.welcome 1개 create · saved plan workflow.tfplan",
    hint: "-out을 생략하면 다음 단계가 같은 plan을 적용할 수 없습니다.",
    troubleshooting: ["No changes가 나오면 이미 apply했는지 state list를 확인하세요.", "초기 상태로 되돌리려면 환경 초기화를 사용하세요."],
    success: "정확히 한 개의 로컬 변경이 담긴 plan을 저장했습니다.",
    validate: verify("saved-plan", "01-workflow", `
test -s workflow.tfplan
terraform show -json workflow.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.welcome" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  $managed[0].change.after.content == "Terraform Lab\\n"
' >/dev/null
planned_filename="$(terraform show -json workflow.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.welcome") | .change.after.filename')"
test "$(realpath -m -- "$planned_filename")" = \
  "$resolved_project/artifacts/welcome.txt"
`),
    expect: [marker("saved-plan")],
    skipSetup: fixture("saved-plan", "01-workflow", workflowCreatePlan),
  },
  {
    id: "apply-local",
    lab: 1,
    title: "저장 plan 적용과 멱등성",
    objective: "검토한 plan을 그대로 적용하고 후속 plan이 no-change인지 확인합니다.",
    description: "workflow.tfplan을 적용해 welcome 파일을 생성하세요.",
    concept: "동일 구성을 반복 적용해도 추가 변경이 없어야 선언적 관리가 성립합니다.",
    command: publicCommand("01-workflow", "terraform apply -input=false -no-color workflow.tfplan"),
    expected: "Apply complete · welcome.txt mode 0600 · 후속 plan no changes",
    hint: "새 plan을 만들지 말고 앞 단계에서 검토한 파일을 인자로 전달하세요.",
    troubleshooting: ["Saved plan is stale이면 환경을 초기화하고 plan부터 다시 만드세요.", "파일 권한이 다르면 file_permission을 확인하세요."],
    success: "저장 plan을 적용하고 멱등 상태를 달성했습니다.",
    validate: verify("apply-local", "01-workflow", `
test "$(terraform state list)" = "local_file.welcome"
terraform show -json | jq -e '
  [.values.root_module.resources[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.welcome" and
  $managed[0].values.file_permission == "0600" and
  $managed[0].values.content == "Terraform Lab\\n"
' >/dev/null
state_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] | select(.address == "local_file.welcome") | .values.filename')"
test "$(realpath -m -- "$state_filename")" = \
  "$resolved_project/artifacts/welcome.txt"
test -f artifacts/welcome.txt
test ! -L artifacts/welcome.txt
test "$(cat artifacts/welcome.txt)" = "Terraform Lab"
test "$(stat -c '%a' artifacts/welcome.txt)" = "600"
set +e
terraform plan -input=false -no-color -detailed-exitcode >/dev/null
plan_status=$?
set -e
test "$plan_status" -eq 0
`),
    expect: [marker("apply-local")],
    skipSetup: fixture("apply-local", "01-workflow", workflowApplied),
  },
  {
    id: "typed-inputs",
    lab: 2,
    title: "타입이 있는 입력 변수",
    objective: "입력 타입과 validation으로 잘못된 값을 plan 전에 차단합니다.",
    description: "environment, replicas, service_ports의 타입과 허용 범위를 선언하세요.",
    concept: "변수 validation은 잘못된 배포 입력을 provider 호출 전에 빠르게 거부합니다.",
    command: publicCommand("02-values", valuesBase.replaceAll(">/dev/null", "")),
    expected: "environment dev|stage|prod · replicas 정수 1–5 · configuration output",
    hint: "set(number)는 순서가 없으므로 출력 전에 명시적으로 정렬하세요.",
    troubleshooting: ["Invalid value for variable은 validation이 정상 동작한 증거일 수 있습니다.", "floor 함수로 정수 여부까지 확인하세요."],
    success: "세 가지 입력을 강한 타입과 범위로 제한했습니다.",
    validate: verify("typed-inputs", "02-values", `
terraform fmt -check -no-color >/dev/null
terraform validate -no-color >/dev/null
grep -F 'version = "${LOCAL_VERSION}"' versions.tf >/dev/null
validation_dir="$(mktemp -d)"
trap 'find "$validation_dir" -xdev -mindepth 1 -delete; rmdir "$validation_dir"' EXIT HUP INT TERM
terraform plan -input=false -no-color -out="$validation_dir/defaults.tfplan" >/dev/null
terraform show -json "$validation_dir/defaults.tfplan" | jq -e '
  .planned_values.outputs.configuration.value == {
    "name": "payments-dev",
    "ports": [8080, 8443],
    "replicas": 2
  }
' >/dev/null
set +e
terraform plan -input=false -no-color -var=environment=evil \
  >"$validation_dir/environment.txt" 2>&1
environment_status=$?
terraform plan -input=false -no-color -var=replicas=99 \
  >"$validation_dir/replicas-range.txt" 2>&1
replicas_range_status=$?
terraform plan -input=false -no-color -var=replicas=2.5 \
  >"$validation_dir/replicas-integer.txt" 2>&1
replicas_integer_status=$?
terraform plan -input=false -no-color -var='service_ports=["bad"]' \
  >"$validation_dir/service-ports.txt" 2>&1
service_ports_status=$?
set -e
test "$environment_status" -ne 0
test "$replicas_range_status" -ne 0
test "$replicas_integer_status" -ne 0
test "$service_ports_status" -ne 0
grep -F 'environment must be dev, stage, or prod.' \
  "$validation_dir/environment.txt" >/dev/null
grep -F 'replicas must be an integer from 1 through 5.' \
  "$validation_dir/replicas-range.txt" >/dev/null
grep -F 'replicas must be an integer from 1 through 5.' \
  "$validation_dir/replicas-integer.txt" >/dev/null
`),
    expect: [marker("typed-inputs")],
    skipSetup: fixture("typed-inputs", "02-values", valuesBase),
  },
  {
    id: "auto-tfvars",
    lab: 2,
    title: "자동 변수 파일과 plan output",
    objective: "auto.tfvars를 적용하고 계산된 output을 saved plan에서 검증합니다.",
    description: "stage 환경, replica 3개, 두 service port를 자동 변수 파일로 전달하세요.",
    concept: "자동 변수 파일은 반복 입력을 줄이지만 저장소에 넣어도 되는 값만 담아야 합니다.",
    command: publicCommand("02-values", `${writeFile("training.auto.tfvars", valuesTfvars)}
terraform fmt -no-color
terraform plan -input=false -no-color -out=values.tfplan`),
    expected: "payments-stage · replicas 3 · ports 8080, 8443",
    hint: "파일명은 정확히 .auto.tfvars로 끝나야 자동 로드됩니다.",
    troubleshooting: ["기본값이 계속 보이면 파일명과 현재 디렉터리를 확인하세요.", "set 값은 output에서 정렬한 뒤 비교하세요."],
    success: "자동 변수 입력이 계산된 configuration에 반영되었습니다.",
    validate: verify("auto-tfvars", "02-values", `
test -f training.auto.tfvars
test ! -L training.auto.tfvars
test "$(find . -maxdepth 1 \
  \\( -name '*.auto.tfvars' -o -name '*.auto.tfvars.json' \\) \
  -print | wc -l)" -eq 1
test -s values.tfplan
terraform show -json values.tfplan | jq -e '
  .planned_values.outputs.configuration.value == {
    "name": "payments-stage",
    "ports": [8080, 8443],
    "replicas": 3
  }
' >/dev/null
validation_dir="$(mktemp -d)"
restore_auto_tfvars() {
  if test -f "$validation_dir/training.auto.tfvars"; then
    mv -f "$validation_dir/training.auto.tfvars" training.auto.tfvars
  fi
  find "$validation_dir" -xdev -mindepth 1 -delete
  rmdir "$validation_dir"
}
trap restore_auto_tfvars EXIT HUP INT TERM
terraform plan -input=false -no-color -out="$validation_dir/with-auto.tfplan" >/dev/null
terraform show -json "$validation_dir/with-auto.tfplan" | jq -e '
  .planned_values.outputs.configuration.value == {
    "name": "payments-stage",
    "ports": [8080, 8443],
    "replicas": 3
  }
' >/dev/null
mv training.auto.tfvars "$validation_dir/training.auto.tfvars"
terraform plan -input=false -no-color -out="$validation_dir/without-auto.tfplan" >/dev/null
terraform show -json "$validation_dir/without-auto.tfplan" | jq -e '
  .planned_values.outputs.configuration.value == {
    "name": "payments-dev",
    "ports": [8080, 8443],
    "replicas": 2
  }
' >/dev/null
mv "$validation_dir/training.auto.tfvars" training.auto.tfvars
`),
    expect: [marker("auto-tfvars")],
    skipSetup: fixture("auto-tfvars", "02-values", valuesPlanned),
  },
  {
    id: "local-render",
    lab: 2,
    title: "locals와 JSON 렌더링",
    objective: "표현식 결과를 jsonencode로 안전하게 직렬화합니다.",
    description: "계산된 stage 구성을 artifacts/inventory.json으로 렌더링하세요.",
    concept: "jsonencode는 직접 문자열을 조합할 때 생기는 escaping 오류를 피합니다.",
    command: publicCommand("02-values", `${writeFile("main.tf", valuesInventory)}
terraform fmt -no-color
terraform apply -input=false -auto-approve -no-color`),
    expected: "inventory.json · payments-stage · replicas 3 · mode 0600",
    hint: "파일 경로는 path.module 아래로 제한하세요.",
    troubleshooting: ["No such file or directory이면 artifacts 디렉터리를 확인하세요.", "JSON 비교에는 텍스트 grep 대신 jq를 사용하세요."],
    success: "타입이 있는 값을 정확한 JSON artifact로 렌더링했습니다.",
    validate: verify("local-render", "02-values", `
test -f artifacts/inventory.json
test ! -L artifacts/inventory.json
test "$(stat -c '%a' artifacts/inventory.json)" = "600"
jq -e '. == {
  "environment": "stage",
  "ports": [8080, 8443],
  "replicas": 3,
  "service": "payments-stage"
}' artifacts/inventory.json >/dev/null
test "$(terraform state list)" = "local_file.inventory"
`),
    expect: [marker("local-render")],
    skipSetup: fixture("local-render", "02-values", valuesRendered),
  },
  {
    id: "sensitive-random",
    lab: 2,
    title: "Synthetic credential과 sensitive",
    objective: "random_password를 생성하고 민감 파일·output의 노출 경계를 설정합니다.",
    description: "실제 시스템에서 사용하지 않는 교육용 자격 증명을 mode 0600 파일로 만드세요.",
    concept: "sensitive 표시는 CLI 노출을 줄이지만 state 암호화를 대신하지 않습니다.",
    command: publicCommand("02-values", `${writeFile("versions.tf", localRandomVersions)}
${writeFile("secrets.tf", valuesSecrets)}
terraform fmt -no-color
terraform init -input=false -no-color
terraform apply -input=false -auto-approve -no-color
terraform output -no-color`),
    expected: `hashicorp/random ${RANDOM_VERSION} · api_password <sensitive> · credential.json 0600`,
    hint: "민감 output은 이름을 지정해 조회하지 말고 전체 output의 redaction만 확인하세요.",
    troubleshooting: ["Provider lock 오류가 나면 init을 먼저 실행하세요.", "권한이 0600이 아니면 local_sensitive_file의 file_permission을 확인하세요."],
    success: "Synthetic credential을 생성하고 UI·파일 노출을 제한했습니다.",
    validate: verify("sensitive-random", "02-values", `
grep -F 'version = "${RANDOM_VERSION}"' versions.tf >/dev/null
test -f artifacts/credential.json
test ! -L artifacts/credential.json
test "$(stat -c '%a' artifacts/credential.json)" = "600"
jq -e '
  (.username == "payments-stage-svc") and
  (.password | length == 24) and
  (.password | test("[A-Z]")) and
  (.password | test("[a-z]")) and
  (.password | test("[0-9]")) and
  (.password | test("[_-]"))
' artifacts/credential.json >/dev/null
terraform show -json | jq -e '
  .values.outputs.api_password.sensitive == true and
  ([.values.root_module.resources[] |
    select(.address == "random_password.api") |
    .sensitive_values.result] == [true])
' >/dev/null
terraform show -json | jq -e \
  --slurpfile credential artifacts/credential.json '
  [.values.root_module.resources[] |
    select(.address == "random_password.api")] as $random |
  [.values.root_module.resources[] |
    select(.address == "local_sensitive_file.credential")] as $files |
  ($random | length) == 1 and
  ($files | length) == 1 and
  $random[0].sensitive_values.result == true and
  $files[0].sensitive_values.content == true and
  $files[0].values.file_permission == "0600" and
  ($files[0].values.content | fromjson) == $credential[0] and
  $random[0].values.result == $credential[0].password and
  .values.outputs.api_password.value == $credential[0].password
' >/dev/null
credential_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] |
    select(.address == "local_sensitive_file.credential") | .values.filename')"
test "$(realpath -m -- "$credential_filename")" = \
  "$resolved_project/artifacts/credential.json"
`),
    expect: [marker("sensitive-random")],
    skipSetup: fixture("sensitive-random", "02-values", valuesSensitive),
  },
  {
    id: "safe-output",
    lab: 2,
    title: "비민감 output만 내보내기",
    objective: "허용된 configuration output만 별도 JSON artifact로 저장합니다.",
    description: "비밀번호를 조회하지 않고 configuration output만 export하세요.",
    concept: "terraform output -json은 민감 값도 평문으로 낼 수 있으므로 안전한 output 이름만 선택해야 합니다.",
    command: publicCommand("02-values", `terraform output -json configuration |
  jq -S . > artifacts/configuration.json`),
    expected: "configuration.json에 name, ports, replicas만 존재",
    hint: "인자 없는 -json output은 사용하지 마세요.",
    troubleshooting: ["Output not found이면 outputs.tf와 apply 상태를 확인하세요.", "artifact에 password 키가 보이면 즉시 삭제하고 지정 output만 다시 내보내세요."],
    success: "비민감 구성만 안전하게 export했습니다.",
    validate: verify("safe-output", "02-values", `
test -f artifacts/configuration.json
test ! -L artifacts/configuration.json
jq -e '. == {
  "name": "payments-stage",
  "ports": [8080, 8443],
  "replicas": 3
}' artifacts/configuration.json >/dev/null
if grep -Eqi 'password|secret|private|result' artifacts/configuration.json; then
  exit 1
fi
`),
    expect: [marker("safe-output")],
    skipSetup: fixture("safe-output", "02-values", `${valuesSensitive}
terraform output -json configuration | jq -S . > artifacts/configuration.json`),
  },
  {
    id: "state-inspect",
    lab: 3,
    title: "State 주소와 속성 조사",
    objective: "state list와 state show로 관리 대상과 기록된 속성을 구분합니다.",
    description: "Synthetic local_file을 적용하고 state inventory를 artifact로 남기세요.",
    concept: "State는 Terraform 주소와 원격·로컬 객체의 binding을 저장합니다. 직접 편집하지 말고 state 명령을 사용해야 합니다.",
    command: publicCommand("03-state/main", `${stateApplied.replaceAll(">/dev/null", "")}
terraform state list | tee artifacts/state-list.txt
terraform state show -no-color local_file.managed > artifacts/state-show.txt`),
    expected: "local_file.managed 1개 · state-list.txt · state-show.txt",
    hint: "state show 출력에는 현재 기록된 속성이 있지만 구성 의도 전체가 담기지는 않습니다.",
    troubleshooting: ["No state file was found이면 apply가 먼저 성공했는지 확인하세요.", "주소는 resource type과 local name을 함께 적으세요."],
    success: "State가 관리하는 정확한 주소와 속성을 감사했습니다.",
    validate: verify("state-inspect", "03-state/main", `
test "$(terraform state list)" = "local_file.managed"
managed_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] | select(.address == "local_file.managed") | .values.filename')"
test "$(realpath -m -- "$managed_filename")" = \
  "$resolved_project/artifacts/service.txt"
test "$(cat artifacts/state-list.txt)" = "local_file.managed"
grep -E 'file_permission[[:space:]]*=[[:space:]]*"0600"' \
  artifacts/state-show.txt >/dev/null
grep -F 'managed by Terraform' artifacts/state-show.txt >/dev/null
test -f artifacts/service.txt
test ! -L artifacts/service.txt
`),
    expect: [marker("state-inspect")],
    skipSetup: fixture("state-inspect", "03-state/main", stateInspected),
  },
  {
    id: "drift-detect",
    lab: 3,
    title: "Out-of-band drift 탐지",
    objective: "Terraform 외부에서 바뀐 파일을 detailed exit code와 saved plan으로 탐지합니다.",
    description: "관리 파일을 수동 변경한 뒤 drift.tfplan을 만들고 exit code 2를 확인하세요.",
    concept: "Detailed exit code 2는 오류가 아니라 현재 상태와 구성 사이에 변경이 있다는 뜻입니다.",
    command: publicCommand("03-state/main", `printf '%s\\n' 'manual drift' > artifacts/service.txt
set +e
terraform plan -input=false -no-color -detailed-exitcode -out=drift.tfplan
plan_status=$?
set -e
test "$plan_status" -eq 2`),
    expected: "detailed exit code 2 · local_file.managed drift",
    hint: "exit code를 바로 저장해야 다음 명령이 $? 값을 덮어쓰지 않습니다.",
    troubleshooting: ["exit code 0이면 파일 내용이 실제로 달라졌는지 확인하세요.", "exit code 1이면 plan 오류이므로 stderr를 먼저 해결하세요."],
    success: "외부 변경을 오류와 구분해 정확히 탐지했습니다.",
    validate: verify("drift-detect", "03-state/main", `
test "$(cat artifacts/service.txt)" = "manual drift"
test -s drift.tfplan
terraform show -json drift.tfplan | jq -e '
  [.resource_drift[]?] as $drift |
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($drift | length) == 1 and
  $drift[0].mode == "managed" and
  $drift[0].address == "local_file.managed" and
  $drift[0].change.actions == ["delete"] and
  ($managed | length) == 1 and
  $managed[0].address == "local_file.managed" and
  $managed[0].change.actions == ["create"]
' >/dev/null
drift_before_filename="$(terraform show -json drift.tfplan |
  jq -er '.resource_drift[] | select(.address == "local_file.managed") | .change.before.filename')"
drift_after_filename="$(terraform show -json drift.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.managed") | .change.after.filename')"
test "$(realpath -m -- "$drift_before_filename")" = \
  "$resolved_project/artifacts/service.txt"
test "$(realpath -m -- "$drift_after_filename")" = \
  "$resolved_project/artifacts/service.txt"
`),
    expect: [marker("drift-detect")],
    skipSetup: fixture("drift-detect", "03-state/main", stateDrifted),
  },
  {
    id: "drift-reconcile",
    lab: 3,
    title: "검토한 drift plan으로 복구",
    objective: "저장한 drift plan을 적용해 선언한 내용으로 되돌립니다.",
    description: "drift.tfplan을 적용하고 후속 plan이 no-change인지 확인하세요.",
    concept: "수동 수정이 아니라 검토된 plan을 적용해야 state와 실제 객체가 같은 계약으로 복구됩니다.",
    command: publicCommand("03-state/main", `terraform show -json drift.tfplan | jq -e '
  [.resource_drift[]?] as $drift |
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($drift | length) == 1 and
  $drift[0].mode == "managed" and
  $drift[0].address == "local_file.managed" and
  $drift[0].change.actions == ["delete"] and
  ($managed | length) == 1 and
  $managed[0].address == "local_file.managed" and
  $managed[0].change.actions == ["create"]
'
drift_before_filename="$(terraform show -json drift.tfplan |
  jq -er '.resource_drift[] | select(.address == "local_file.managed") | .change.before.filename')"
drift_after_filename="$(terraform show -json drift.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.managed") | .change.after.filename')"
test "$(realpath -m -- "$drift_before_filename")" = \
  "$resolved_project/artifacts/service.txt"
test "$(realpath -m -- "$drift_after_filename")" = \
  "$resolved_project/artifacts/service.txt"
terraform apply -input=false -no-color drift.tfplan`),
    expected: "service.txt 원복 · 후속 plan exit code 0",
    hint: "새 plan 대신 앞 단계에서 drift를 확인한 saved plan을 적용하세요.",
    troubleshooting: ["Saved plan is stale이면 drift 탐지 단계를 다시 실행하세요.", "파일이 계속 바뀐다면 외부 프로세스가 수정하는지 확인하세요."],
    success: "Drift를 선언된 상태로 안전하게 복구했습니다.",
    validate: verify("drift-reconcile", "03-state/main", `
test "$(cat artifacts/service.txt)" = "managed by Terraform"
test "$(terraform state list)" = "local_file.managed"
terraform show -json | jq -e '
  [.values.root_module.resources[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.managed" and
  $managed[0].values.content == "managed by Terraform\\n" and
  $managed[0].values.file_permission == "0600"
' >/dev/null
managed_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] | select(.address == "local_file.managed") | .values.filename')"
test "$(realpath -m -- "$managed_filename")" = \
  "$resolved_project/artifacts/service.txt"
set +e
terraform plan -input=false -no-color -detailed-exitcode >/dev/null
plan_status=$?
set -e
test "$plan_status" -eq 0
`),
    expect: [marker("drift-reconcile")],
    skipSetup: fixture("drift-reconcile", "03-state/main", stateReconciled),
  },
  {
    id: "backup-destroy",
    lab: 3,
    title: "State 백업 후 제한된 destroy",
    objective: "State와 checksum을 보존하고 JSON gate를 통과한 destroy plan만 적용합니다.",
    description: "별도 destroy-demo의 synthetic 파일 하나만 안전하게 정리하세요.",
    concept: "Destroy도 create와 같은 검토 절차가 필요합니다. 이 단계는 다른 Lab state와 분리된 로컬 객체만 삭제합니다.",
    command: publicCommand("03-state/destroy-demo", backupDestroy.replaceAll(">/dev/null", "")),
    expected: "백업 checksum 일치 · delete 1개 · disposable.txt 제거",
    hint: "terraform show -json gate가 성공하기 전에는 destroy plan을 apply하지 마세요.",
    troubleshooting: ["Gate가 실패하면 apply하지 말고 plan의 주소와 actions를 확인하세요.", "Checksum 오류가 나면 백업 파일을 다시 생성하세요."],
    success: "State를 백업하고 정확히 한 개의 synthetic 객체만 삭제했습니다.",
    validate: verify("backup-destroy", "03-state/destroy-demo", `
test -f artifacts/pre-destroy.tfstate.json
test "$(stat -c '%a' artifacts/pre-destroy.tfstate.json)" = "600"
sha256sum -c artifacts/pre-destroy.tfstate.json.sha256 >/dev/null
terraform show -json destroy.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.disposable" and
  $managed[0].change.actions == ["delete"]
' >/dev/null
destroy_filename="$(terraform show -json destroy.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.disposable") | .change.before.filename')"
test "$(realpath -m -- "$destroy_filename")" = \
  "$resolved_project/artifacts/disposable.txt"
test -z "$(terraform state list)"
test ! -e artifacts/disposable.txt
`),
    expect: [marker("backup-destroy")],
    skipSetup: fixture("backup-destroy", "03-state/destroy-demo", backupDestroy),
  },
  {
    id: "foreach-files",
    lab: 4,
    title: "for_each로 이름 있는 인스턴스",
    objective: "Map key를 안정적인 resource instance 주소로 사용합니다.",
    description: "api, web, worker 세 서비스 manifest를 for_each로 생성하세요.",
    concept: "for_each 주소는 의미 있는 key를 사용해 목록 순서 변경에 따른 불필요한 교체를 줄입니다.",
    command: publicCommand("04-graph", graphBase.replaceAll(">/dev/null", "")),
    expected: "api 8080 · web 8081 · worker 9090 · local_file instance 3개",
    hint: "each.key는 파일명, each.value는 port로 사용하세요.",
    troubleshooting: ["Invalid for_each argument이면 map 값이 plan 시점에 알려져 있는지 확인하세요.", "주소를 조회할 때 대괄호와 따옴표를 함께 사용하세요."],
    success: "의미 있는 key를 가진 세 resource instance를 생성했습니다.",
    validate: verify("foreach-files", "04-graph", `
test "$(terraform state list | sort)" = 'local_file.service["api"]
local_file.service["web"]
local_file.service["worker"]'
jq -e '. == {"name":"api","port":8080}' artifacts/api.json >/dev/null
jq -e '. == {"name":"web","port":8081}' artifacts/web.json >/dev/null
jq -e '. == {"name":"worker","port":9090}' artifacts/worker.json >/dev/null
`),
    expect: [marker("foreach-files")],
    skipSetup: fixture("foreach-files", "04-graph", graphBase),
  },
  {
    id: "count-random",
    lab: 4,
    title: "count와 stable keeper",
    objective: "count.index를 keeper에 연결해 세 개의 안정적인 random ID를 관리합니다.",
    description: "byte length 4인 random_id 인스턴스 세 개를 추가하세요.",
    concept: "count 주소는 숫자 index이므로 목록 삽입이 주소 이동을 만들 수 있습니다. keeper는 재생성 조건을 명시합니다.",
    command: publicCommand("04-graph", `${writeFile("versions.tf", localRandomVersions)}
${writeFile("random.tf", graphRandom)}
terraform fmt -no-color
terraform init -input=false -no-color
terraform apply -input=false -auto-approve -no-color`),
    expected: `hashicorp/random ${RANDOM_VERSION} · 고유한 8자리 hex ID 3개`,
    hint: "random_id의 hex 길이는 byte_length의 두 배입니다.",
    troubleshooting: ["ID가 계속 바뀌면 keeper 값이 매 plan마다 달라지지 않는지 확인하세요.", "Provider not found이면 init을 다시 실행하세요."],
    success: "세 개의 안정적인 random instance와 주소를 확인했습니다.",
    validate: verify("count-random", "04-graph", `
grep -F 'version = "${RANDOM_VERSION}"' versions.tf >/dev/null
terraform output -json node_ids | jq -e '
  length == 3 and
  (unique | length) == 3 and
  all(.[]; test("^[0-9a-f]{8}$"))
' >/dev/null
test "$(terraform state list | grep -F -c 'random_id.node[')" -eq 3
terraform show -json | jq -e '
  [.values.root_module.resources[] |
    select(.address | startswith("random_id.node["))] as $nodes |
  ($nodes | length) == 3 and
  ([$nodes[].values.byte_length] | all(. == 4)) and
  ([$nodes[].values.keepers.slot] | sort) == ["0", "1", "2"]
' >/dev/null
`),
    expect: [marker("count-random")],
    skipSetup: fixture("count-random", "04-graph", graphCounted),
  },
  {
    id: "explicit-dependency",
    lab: 4,
    title: "명시적 dependency gate",
    objective: "부작용 없는 null_resource로 세 manifest 이후의 gate를 표현합니다.",
    description: "provisioner 없이 manifest_gate를 추가하고 local files에 명시적으로 의존시키세요.",
    concept: "depends_on은 표현식만으로 드러나지 않는 순서를 나타낼 때 제한적으로 사용합니다. 이 과정은 provisioner를 허용하지 않습니다.",
    command: publicCommand("04-graph", `${writeFile("versions.tf", graphVersions)}
${writeFile("dependency.tf", graphDependency)}
terraform fmt -no-color
terraform init -input=false -no-color
terraform apply -input=false -auto-approve -no-color`),
    expected: `hashicorp/null ${NULL_VERSION} · manifest_gate trigger 고정`,
    hint: "null_resource 안에 local-exec나 다른 provisioner를 추가하지 마세요.",
    troubleshooting: ["Dependency cycle이면 양방향 depends_on이 생기지 않았는지 확인하세요.", "Trigger 변경은 null resource 교체를 유발합니다."],
    success: "부작용 없이 명시적 dependency gate를 구성했습니다.",
    validate: verify("explicit-dependency", "04-graph", `
grep -F 'version = "${NULL_VERSION}"' versions.tf >/dev/null
terraform state show -no-color null_resource.manifest_gate |
  grep -F '"contract" = "all-service-files-ready"' >/dev/null
terraform graph -type=plan | grep -F \
  '"[root] null_resource.manifest_gate (expand)" -> "[root] local_file.service (expand)"' >/dev/null
if grep -ER 'provisioner|local-exec|remote-exec' --include='*.tf' .; then
  exit 1
fi
`),
    expect: [marker("explicit-dependency")],
    skipSetup: fixture("explicit-dependency", "04-graph", graphDependent),
  },
  {
    id: "graph-export",
    lab: 4,
    title: "실행 그래프와 state inventory export",
    objective: "Terraform dependency graph와 state 주소를 검토 가능한 artifact로 저장합니다.",
    description: "plan graph를 DOT으로, 현재 주소를 정렬된 텍스트로 내보내세요.",
    concept: "Graph는 병렬 실행과 의존 순서를 설명하고 state inventory는 현재 관리 범위를 증명합니다.",
    command: publicCommand("04-graph", `terraform graph -type=plan > artifacts/graph.dot
terraform state list | sort > artifacts/resources.txt`),
    expected: "graph.dot · local 3 + random 3 + null 1 주소",
    hint: "graph 출력은 터미널에서 읽기보다 DOT artifact로 보존하는 편이 좋습니다.",
    troubleshooting: ["그래프가 비어 있으면 현재 프로젝트와 workspace를 확인하세요.", "state 목록 수가 다르면 이전 apply 결과를 확인하세요."],
    success: "의존 그래프와 일곱 개 관리 주소를 artifact로 남겼습니다.",
    validate: verify("graph-export", "04-graph", `
test -f artifacts/graph.dot
test -f artifacts/resources.txt
grep -F 'digraph' artifacts/graph.dot >/dev/null
grep -F 'local_file.service' artifacts/graph.dot >/dev/null
grep -F 'random_id.node' artifacts/graph.dot >/dev/null
grep -F 'null_resource.manifest_gate' artifacts/graph.dot >/dev/null
test "$(wc -l < artifacts/resources.txt | tr -d ' ')" -eq 7
test "$(sort artifacts/resources.txt)" = "$(terraform state list | sort)"
`),
    expect: [marker("graph-export")],
    skipSetup: fixture("graph-export", "04-graph", `${graphDependent}
terraform graph -type=plan > artifacts/graph.dot
terraform state list | sort > artifacts/resources.txt`),
  },
  {
    id: "module-contract",
    lab: 5,
    title: "재사용 가능한 module 계약",
    objective: "명시적 입력 validation과 output을 가진 local module을 작성합니다.",
    description: "modules/artifact에 name, content, output_dir 입력과 path output을 정의하세요.",
    concept: "Module은 복사 가능한 폴더가 아니라 입력·출력·provider 요구사항으로 표현한 재사용 계약입니다.",
    command: publicCommand("05-modules", moduleContract.replaceAll(">/dev/null", "")),
    expected: "local source module · lowercase name validation · local_file mode 0600",
    hint: "Child module에도 required_providers source를 명시하세요.",
    troubleshooting: ["Module not installed이면 child 디렉터리에서 init을 실행하세요.", "Variable validation 오류는 name 정규식을 확인하세요."],
    success: "입력과 출력이 명확한 local artifact module을 만들었습니다.",
    validate: verify("module-contract", "05-modules", `
terraform fmt -check -recursive -no-color >/dev/null
terraform -chdir=modules/artifact validate -no-color >/dev/null
grep -F 'version = "${LOCAL_VERSION}"' modules/artifact/versions.tf >/dev/null
validation_dir="$(mktemp -d)"
trap 'find "$validation_dir" -xdev -mindepth 1 -delete; rmdir "$validation_dir"' EXIT HUP INT TERM
terraform -chdir=modules/artifact plan -input=false -no-color \
  -var=name=valid-service \
  -var=content=contract \
  -var="output_dir=$resolved_project/artifacts" \
  -out="$validation_dir/module.tfplan" >/dev/null
terraform -chdir=modules/artifact show -json "$validation_dir/module.tfplan" | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.this" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  $managed[0].change.after.content == "contract\\n"
' >/dev/null
module_filename="$(terraform -chdir=modules/artifact show -json \
  "$validation_dir/module.tfplan" |
  jq -er '.resource_changes[] | select(.address == "local_file.this") | .change.after.filename')"
test "$(realpath -m -- "$module_filename")" = \
  "$resolved_project/artifacts/valid-service.txt"
set +e
terraform -chdir=modules/artifact plan -input=false -no-color \
  -var=name=INVALID \
  -var=content=contract \
  -var="output_dir=$resolved_project/artifacts" \
  >"$validation_dir/invalid-name.txt" 2>&1
invalid_name_status=$?
set -e
test "$invalid_name_status" -ne 0
grep -F 'name must be a lowercase service name.' \
  "$validation_dir/invalid-name.txt" >/dev/null
`),
    expect: [marker("module-contract")],
    skipSetup: fixture("module-contract", "05-modules", moduleContract),
  },
  {
    id: "module-call",
    lab: 5,
    title: "for_each module 호출",
    objective: "한 local module을 두 개의 이름 있는 component로 인스턴스화합니다.",
    description: "backend와 frontend artifact를 같은 module contract로 생성하세요.",
    concept: "Module에도 for_each를 적용하면 각 instance가 독립적이고 안정적인 주소를 갖습니다.",
    command: publicCommand("05-modules", `${writeFile("versions.tf", localVersions)}
${writeFile("main.tf", moduleRoot)}
terraform fmt -recursive -no-color
terraform init -input=false -no-color
terraform apply -input=false -auto-approve -no-color`),
    expected: "module.artifact[backend] · module.artifact[frontend] · 파일 2개",
    hint: "source는 반드시 ./modules/artifact처럼 local 상대 경로를 사용하세요.",
    troubleshooting: ["Unreadable module directory이면 source 경로를 확인하세요.", "Duplicate module call이면 root main.tf의 기존 블록을 확인하세요."],
    success: "같은 module로 두 component artifact를 생성했습니다.",
    validate: verify("module-call", "05-modules", `
test "$(terraform state list | sort)" = 'module.artifact["backend"].local_file.this
module.artifact["frontend"].local_file.this'
test "$(cat artifacts/backend.txt)" = "api"
test "$(cat artifacts/frontend.txt)" = "ui"
test "$(stat -c '%a' artifacts/backend.txt)" = "600"
test "$(stat -c '%a' artifacts/frontend.txt)" = "600"
`),
    expect: [marker("module-call")],
    skipSetup: fixture("module-call", "05-modules", moduleCalled),
  },
  {
    id: "module-output",
    lab: 5,
    title: "Module output 집계",
    objective: "Module instance별 path를 비민감 JSON map으로 내보냅니다.",
    description: "artifact_paths output 하나만 정렬된 JSON으로 저장하세요.",
    concept: "Root output은 child module 내부 구현 대신 소비자가 필요한 안정적인 계약만 노출해야 합니다.",
    command: publicCommand("05-modules", `terraform output -json artifact_paths |
  jq -S . > artifacts/module-outputs.json`),
    expected: "backend와 frontend path만 포함한 module-outputs.json",
    hint: "전체 output 대신 안전한 artifact_paths 이름을 지정하세요.",
    troubleshooting: ["Output not found이면 root output 블록과 apply를 확인하세요.", "절대 경로가 session 밖을 가리키면 output_dir을 path.root 아래로 고치세요."],
    success: "두 module 결과를 안전한 root output으로 집계했습니다.",
    validate: verify("module-output", "05-modules", `
test -f artifacts/module-outputs.json
jq -e '
  (keys | sort) == ["backend", "frontend"] and
  (.backend | endswith("/artifacts/backend.txt")) and
  (.frontend | endswith("/artifacts/frontend.txt"))
' artifacts/module-outputs.json >/dev/null
if grep -Eqi 'password|secret|private' artifacts/module-outputs.json; then
  exit 1
fi
`),
    expect: [marker("module-output")],
    skipSetup: fixture("module-output", "05-modules", moduleOutputWritten),
  },
  {
    id: "terraform-test",
    lab: 5,
    title: "Terraform native test",
    objective: "Plan 기반 assert로 module의 output contract를 자동 검증합니다.",
    description: "두 artifact와 파일명 규칙을 확인하는 tftest.hcl을 실행하세요.",
    concept: "terraform test는 apply 전 구성 계약을 반복 검증해 module 변경의 회귀를 줄입니다.",
    command: publicCommand("05-modules", `${writeFile("tests/artifact.tftest.hcl", moduleTest)}
terraform fmt -recursive -no-color
terraform test -no-color > artifacts/test-results.txt
tail -n 5 artifacts/test-results.txt`),
    expected: "1 passed · 0 failed",
    hint: "Pipeline으로 tee를 사용하면 pipefail 없이 실패가 숨겨질 수 있으므로 파일로 먼저 저장하세요.",
    troubleshooting: ["Test assertion failed이면 output map의 key와 path를 비교하세요.", "Tests directory가 root module 아래인지 확인하세요."],
    success: "Module contract를 자동화된 native test로 증명했습니다.",
    validate: verify("terraform-test", "05-modules", `
terraform test -no-color >/dev/null
validation_dir="$(mktemp -d)"
restore_test_files() {
  if test -f "$validation_dir/main.tf.original"; then
    mv -f "$validation_dir/main.tf.original" main.tf
  fi
  if test -f "$validation_dir/outputs.tf.original"; then
    mv -f "$validation_dir/outputs.tf.original" modules/artifact/outputs.tf
  fi
  find "$validation_dir" -xdev -mindepth 1 -delete
  rmdir "$validation_dir"
}
trap restore_test_files EXIT HUP INT TERM
cp main.tf "$validation_dir/main.tf.original"
sed '/frontend = "ui"/d' "$validation_dir/main.tf.original" > main.tf.candidate
mv -f main.tf.candidate main.tf
terraform fmt -recursive -no-color >/dev/null
set +e
terraform test -no-color >"$validation_dir/component-count.txt" 2>&1
component_count_status=$?
set -e
test "$component_count_status" -ne 0
grep -F 'Exactly two artifacts are required.' \
  "$validation_dir/component-count.txt" >/dev/null
mv -f "$validation_dir/main.tf.original" main.tf
cp modules/artifact/outputs.tf "$validation_dir/outputs.tf.original"
sed 's|value = local_file.this.filename|value = "\${local_file.this.filename}.invalid"|' \
  "$validation_dir/outputs.tf.original" > modules/artifact/outputs.tf.candidate
mv -f modules/artifact/outputs.tf.candidate modules/artifact/outputs.tf
terraform fmt -recursive -no-color >/dev/null
set +e
terraform test -no-color >"$validation_dir/artifact-path.txt" 2>&1
artifact_path_status=$?
set -e
test "$artifact_path_status" -ne 0
grep -F 'Every artifact path must match its module key.' \
  "$validation_dir/artifact-path.txt" >/dev/null
mv -f "$validation_dir/outputs.tf.original" modules/artifact/outputs.tf
`),
    expect: [marker("terraform-test")],
    skipSetup: fixture("terraform-test", "05-modules", moduleTested),
  },
  {
    id: "moved-refactor",
    lab: 5,
    title: "moved block 무중단 refactor",
    objective: "Resource local name을 바꾸면서 create/delete 없이 state 주소를 이동합니다.",
    description: "child의 local_file.this를 local_file.artifact로 바꾸고 moved block을 적용하세요.",
    concept: "moved block은 코드 구조 변경을 객체 재생성으로 오해하지 않도록 이전 주소와 새 주소를 연결합니다.",
    command: publicCommand("05-modules", `${writeFile("modules/artifact/main.tf", movedModuleResource)}
${writeFile("modules/artifact/outputs.tf", movedModuleOutput)}
terraform fmt -recursive -no-color
terraform plan -input=false -no-color -out=refactor.tfplan
terraform show -json refactor.tfplan | jq -e '
  [.resource_changes[]? |
    select(.mode == "managed") |
    .change.actions[] |
    select(. != "no-op")] |
  length == 0
'
terraform apply -input=false -no-color refactor.tfplan`),
    expected: "create 0 · update 0 · delete 0 · 새 state 주소 2개",
    hint: "Plan JSON gate가 non-no-op action 0개인지 확인한 뒤 apply하세요.",
    troubleshooting: ["Delete/create가 보이면 moved block의 from과 to scope를 확인하세요.", "Output 참조도 새 resource 이름으로 함께 바꾸세요."],
    success: "실제 파일을 재생성하지 않고 module 내부 주소를 이동했습니다.",
    validate: verify("moved-refactor", "05-modules", `
terraform show -json refactor.tfplan | jq -e '
  [.resource_changes[]? |
    select(.mode == "managed") |
    .change.actions[] |
    select(. != "no-op")] |
  length == 0
' >/dev/null
test "$(terraform state list | sort)" = 'module.artifact["backend"].local_file.artifact
module.artifact["frontend"].local_file.artifact'
test "$(cat artifacts/backend.txt)" = "api"
test "$(cat artifacts/frontend.txt)" = "ui"
`),
    expect: [marker("moved-refactor")],
    skipSetup: fixture("moved-refactor", "05-modules", moduleMoved),
  },
  {
    id: "tls-keypair",
    lab: 6,
    title: "Synthetic TLS keypair",
    objective: "교육 전용 keypair를 만들고 두 artifact를 모두 세션 소유자에게만 제한합니다.",
    description: "ED25519 keypair를 생성하되 실제 인증에 사용하지 말고 private·public 파일을 mode 0600으로 제한하세요.",
    concept: "TLS provider가 만든 private material도 state에 저장됩니다. 이 key는 오직 격리된 세션에서 state 보안 학습용으로만 사용합니다.",
    command: publicCommand("06-security", securityApplied.replaceAll(">/dev/null", "")),
    expected: `hashicorp/tls ${TLS_VERSION} · private 0600 · public 0600`,
    hint: "Private key를 output으로 선언하거나 터미널에 출력하지 마세요.",
    troubleshooting: ["ssh-keygen이 key를 읽지 못하면 파일 권한과 ED25519 형식을 확인하세요.", "Provider 설치 실패는 offline mirror와 lock을 확인하세요."],
    success: "Synthetic keypair와 최소 파일 권한을 구성했습니다.",
    validate: verify("tls-keypair", "06-security", `
grep -F 'version = "${TLS_VERSION}"' versions.tf >/dev/null
test -f artifacts/learner-key
test ! -L artifacts/learner-key
test "$(stat -c '%a' artifacts/learner-key)" = "600"
test "$(stat -c '%a' artifacts/learner-key.pub)" = "600"
derived_public="$(ssh-keygen -y -f artifacts/learner-key)"
recorded_public="$(awk '{ print $1 " " $2 }' artifacts/learner-key.pub)"
test "$derived_public" = "$recorded_public"
test "$(terraform state list | sort)" = 'local_file.public_key
local_sensitive_file.private_key
tls_private_key.learner'
terraform show -json | jq -e \
  --rawfile private artifacts/learner-key \
  --rawfile public artifacts/learner-key.pub '
  [.values.root_module.resources[] |
    select(.address == "tls_private_key.learner")] as $tls |
  [.values.root_module.resources[] |
    select(.address == "local_sensitive_file.private_key")] as $private_files |
  [.values.root_module.resources[] |
    select(.address == "local_file.public_key")] as $public_files |
  ($tls | length) == 1 and
  ($private_files | length) == 1 and
  ($public_files | length) == 1 and
  $tls[0].sensitive_values.private_key_openssh == true and
  $private_files[0].sensitive_values.content == true and
  $tls[0].values.private_key_openssh == $private and
  $private_files[0].values.content == $private and
  $private_files[0].values.file_permission == "0600" and
  $public_files[0].values.content == $public and
  $public_files[0].values.file_permission == "0600" and
  ($tls[0].values.public_key_openssh | rtrimstr("\\n")) ==
    ($public | split(" ") | .[0:2] | join(" "))
' >/dev/null
private_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] |
    select(.address == "local_sensitive_file.private_key") | .values.filename')"
public_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] |
    select(.address == "local_file.public_key") | .values.filename')"
test "$(realpath -m -- "$private_filename")" = \
  "$resolved_project/artifacts/learner-key"
test "$(realpath -m -- "$public_filename")" = \
  "$resolved_project/artifacts/learner-key.pub"
state_fingerprint="$(terraform output -raw public_key_fingerprint)"
artifact_fingerprint="$(ssh-keygen -lf artifacts/learner-key.pub -E sha256 | awk '{ print $2 }')"
test "$state_fingerprint" = "$artifact_fingerprint"
`),
    expect: [marker("tls-keypair")],
    skipSetup: fixture("tls-keypair", "06-security", securityApplied),
  },
  {
    id: "sensitive-state-audit",
    lab: 6,
    title: "Sensitive state 노출 감사",
    objective: "원문을 출력하지 않고 state에 민감 속성이 존재한다는 사실만 증명합니다.",
    description: "State JSON의 sensitive metadata를 검사하고 sanitized report를 만드세요.",
    concept: "sensitive는 표시 제어이며 state 암호화가 아닙니다. 운영에서는 암호화된 backend와 접근 제한이 함께 필요합니다.",
    command: publicCommand("06-security", `terraform show -json |
  jq -e '
    .values.root_module.resources[] |
    select(.address == "tls_private_key.learner") |
    .sensitive_values.private_key_openssh == true
  ' >/dev/null
jq -n '{
  state_contains_sensitive_values: true,
  mitigation: "encrypted remote backend + restricted access"
}' > artifacts/sensitive-audit.json`),
    expected: "민감 값 존재 true · 원문 없는 mitigation report",
    hint: "values가 아니라 sensitive_values metadata만 predicate로 검사하세요.",
    troubleshooting: ["Report에 key 본문이 포함되면 즉시 삭제하고 정적 요약만 다시 만드세요.", "State 파일을 cat하거나 전체 output -json을 화면에 출력하지 마세요."],
    success: "민감 원문을 노출하지 않고 state 위험을 감사했습니다.",
    validate: verify("sensitive-state-audit", "06-security", `
test -f artifacts/sensitive-audit.json
test ! -L artifacts/sensitive-audit.json
test "$(stat -c '%a' artifacts/sensitive-audit.json)" = "600"
jq -e '. == {
  "mitigation": "encrypted remote backend + restricted access",
  "state_contains_sensitive_values": true
}' artifacts/sensitive-audit.json >/dev/null
if grep -Eqi 'BEGIN .*PRIVATE KEY|OPENSSH PRIVATE KEY|private_key_openssh' artifacts/sensitive-audit.json; then
  exit 1
fi
test "$(stat -c '%a' terraform.tfstate)" = "600"
test "$(terraform state list | sort)" = 'local_file.public_key
local_sensitive_file.private_key
tls_private_key.learner'
terraform show -json | jq -e \
  --rawfile private artifacts/learner-key \
  --rawfile public artifacts/learner-key.pub '
  [.values.root_module.resources[] |
    select(.address == "tls_private_key.learner")] as $tls |
  [.values.root_module.resources[] |
    select(.address == "local_sensitive_file.private_key")] as $private_files |
  [.values.root_module.resources[] |
    select(.address == "local_file.public_key")] as $public_files |
  ($tls | length) == 1 and
  ($private_files | length) == 1 and
  ($public_files | length) == 1 and
  $tls[0].sensitive_values.private_key_openssh == true and
  $private_files[0].sensitive_values.content == true and
  $tls[0].values.private_key_openssh == $private and
  $private_files[0].values.content == $private and
  $private_files[0].values.file_permission == "0600" and
  $public_files[0].values.content == $public and
  $public_files[0].values.file_permission == "0600"
' >/dev/null
private_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] |
    select(.address == "local_sensitive_file.private_key") | .values.filename')"
public_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] |
    select(.address == "local_file.public_key") | .values.filename')"
test "$(realpath -m -- "$private_filename")" = \
  "$resolved_project/artifacts/learner-key"
test "$(realpath -m -- "$public_filename")" = \
  "$resolved_project/artifacts/learner-key.pub"
`),
    expect: [marker("sensitive-state-audit")],
    skipSetup: fixture("sensitive-state-audit", "06-security", securityAudited),
  },
  {
    id: "conditions-checks",
    lab: 6,
    title: "Variable validation과 check block",
    objective: "잘못된 algorithm을 plan 전에 거부하고 private file mode를 지속 검사합니다.",
    description: "ED25519만 허용하는 variable validation과 mode 0600 check를 추가하세요.",
    concept: "Validation은 입력 계약, check는 적용 결과에 대한 지속 가능한 assertion을 표현합니다.",
    command: publicCommand("06-security", `${writeFile("main.tf", securityCheckedMain)}
terraform fmt -no-color
terraform plan -input=false -no-color -out=security.tfplan
if terraform plan -input=false -no-color -var=key_algorithm=DES > artifacts/rejected-plan.txt 2>&1; then
  false
else
  grep -F 'key_algorithm must be ED25519.' artifacts/rejected-plan.txt
fi`),
    expected: "정상 plan no-change · DES 입력은 validation error",
    hint: "Negative test가 성공하면 오히려 단계 실패입니다.",
    troubleshooting: ["Invalid variable이 허용되면 validation condition을 확인하세요.", "Check warning은 file_permission 참조가 정확한지 확인하세요."],
    success: "정상 입력은 허용하고 잘못된 입력은 정확한 사유로 거부했습니다.",
    validate: verify("conditions-checks", "06-security", `
terraform validate -no-color >/dev/null
validation_dir="$(mktemp -d)"
restore_condition_files() {
  if test -f "$validation_dir/main.tf.original"; then
    mv -f "$validation_dir/main.tf.original" main.tf
  fi
  find "$validation_dir" -xdev -mindepth 1 -delete
  rmdir "$validation_dir"
}
trap restore_condition_files EXIT HUP INT TERM
validation_plan="$validation_dir/security.tfplan"
negative_output="$validation_dir/rejected-plan.txt"
terraform plan -input=false -no-color -out="$validation_plan" >/dev/null
terraform show -json "$validation_plan" | jq -e '
  [.resource_changes[]? |
    select(.mode == "managed") |
    .change.actions[] |
    select(. != "no-op")] |
  length == 0
' >/dev/null
terraform show -json "$validation_plan" | jq -e '
  [.checks[]? |
    select(
      .address.kind == "check" and
      .address.name == "secure_private_key_file" and
      .status == "pass"
    )] |
  length == 1
' >/dev/null
set +e
terraform plan -input=false -no-color -var=key_algorithm=DES >"$negative_output" 2>&1
negative_status=$?
set -e
test "$negative_status" -ne 0
grep -F 'key_algorithm must be ED25519.' "$negative_output" >/dev/null
test "$(stat -c '%a' artifacts/learner-key)" = "600"
cp main.tf "$validation_dir/main.tf.original"
sed '0,/file_permission = "0600"/s//file_permission = "0644"/' \
  "$validation_dir/main.tf.original" > main.tf.candidate
test "$(grep -c 'file_permission = "0644"' main.tf.candidate)" -eq 1
mv -f main.tf.candidate main.tf
terraform fmt -check -no-color >/dev/null
terraform plan -input=false -no-color \
  -out="$validation_dir/insecure-mode.tfplan" >"$validation_dir/insecure-mode.txt" 2>&1
terraform show -json "$validation_dir/insecure-mode.tfplan" | jq -e '
  [.checks[]? |
    select(
      .address.kind == "check" and
      .address.name == "secure_private_key_file" and
      .status == "fail"
    )] |
  length == 1
' >/dev/null
grep -F 'Private key files must use mode 0600.' \
  "$validation_dir/insecure-mode.txt" >/dev/null
mv -f "$validation_dir/main.tf.original" main.tf
`),
    expect: [marker("conditions-checks")],
    skipSetup: fixture("conditions-checks", "06-security", securityChecked),
  },
  {
    id: "lock-integrity",
    lab: 6,
    title: "Provider lock 무결성",
    objective: "승인 mirror에서 linux_amd64 checksum을 고정하고 readonly init으로 검증합니다.",
    description: "local과 tls provider lock을 다시 계산하고 lock file hash를 artifact로 남기세요.",
    concept: "Provider source·version·checksum 고정은 공급망 변경을 예측 가능한 검토 대상으로 만듭니다.",
    command: publicCommand("06-security", `terraform providers lock \\
  -fs-mirror=/opt/terraform-lab/providers \\
  -platform=linux_amd64
terraform init -input=false -no-color -lockfile=readonly
sha256sum .terraform.lock.hcl > artifacts/lock.sha256`),
    expected: `local ${LOCAL_VERSION} · tls ${TLS_VERSION} · readonly init 성공`,
    hint: "Registry direct 설치가 아니라 승인된 filesystem mirror를 명시하세요.",
    troubleshooting: ["Provider package unavailable이면 mirror의 linux_amd64 layout을 확인하세요.", "Checksum mismatch이면 apply하지 말고 image build artifact를 검토하세요."],
    success: "Provider 버전과 checksum을 재현 가능한 lock으로 고정했습니다.",
    validate: verify("lock-integrity", "06-security", `
grep -F 'registry.terraform.io/hashicorp/local' .terraform.lock.hcl >/dev/null
grep -F 'registry.terraform.io/hashicorp/tls' .terraform.lock.hcl >/dev/null
grep -F 'version     = "${LOCAL_VERSION}"' .terraform.lock.hcl >/dev/null
grep -F 'version     = "${TLS_VERSION}"' .terraform.lock.hcl >/dev/null
grep -E 'h1:|zh:' .terraform.lock.hcl >/dev/null
terraform init -input=false -no-color -lockfile=readonly >/dev/null
sha256sum -c artifacts/lock.sha256 >/dev/null
`),
    expect: [marker("lock-integrity")],
    skipSetup: fixture("lock-integrity", "06-security", `${securityChecked}
terraform providers lock -fs-mirror=/opt/terraform-lab/providers -platform=linux_amd64 >/dev/null
terraform init -input=false -no-color -lockfile=readonly >/dev/null
sha256sum .terraform.lock.hcl > artifacts/lock.sha256`),
  },
  {
    id: "workspace-stage",
    lab: 7,
    title: "Stage workspace 격리",
    objective: "별도 stage workspace를 만들고 default와 분리된 state를 적용합니다.",
    description: "현재 workspace 이름과 release version을 담은 synthetic release artifact를 생성하세요.",
    concept: "CLI workspace는 같은 구성의 state를 분리합니다. 계정·권한 경계 대신 쓰는 기능은 아니지만 교육용 환경 격리에 유용합니다.",
    command: publicCommand("07-operations", operationsApplied.replaceAll(">/dev/null", "")),
    expected: "workspace stage · release v1 · stage 전용 state",
    hint: "select가 실패할 때만 new를 실행해 명령을 반복 가능하게 만드세요.",
    troubleshooting: ["Workspace already exists이면 select stage를 실행하세요.", "Artifact 경로에 default가 보이면 현재 workspace를 확인하세요."],
    success: "Stage workspace와 state를 default에서 분리했습니다.",
    validate: verify("workspace-stage", "07-operations", `
test "$(terraform workspace show)" = "stage"
test "$(terraform state list)" = "local_file.release"
release_filename="$(terraform show -json |
  jq -er '.values.root_module.resources[] | select(.address == "local_file.release") | .values.filename')"
test "$(realpath -m -- "$release_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
test -f artifacts/stage/release.json
test ! -L artifacts/stage/release.json
test "$(stat -c '%a' artifacts/stage/release.json)" = "600"
jq -e '. == {"version":"v1","workspace":"stage"}' artifacts/stage/release.json >/dev/null
test -f terraform.tfstate.d/stage/terraform.tfstate
`),
    expect: [marker("workspace-stage")],
    skipSetup: fixture("workspace-stage", "07-operations", operationsApplied),
  },
  {
    id: "replace-release",
    lab: 7,
    title: "Saved replace plan release",
    objective: "-replace로 의도한 local resource 하나만 교체하고 JSON gate 후 적용합니다.",
    description: "local_file.release의 replace plan을 저장해 delete/create 쌍을 검토하세요.",
    concept: "강제 교체는 장애 대응 도구입니다. 주소와 action을 자동 gate하지 않으면 예상 밖 교체로 번질 수 있습니다.",
    command: publicCommand("07-operations", `terraform workspace select stage >/dev/null
terraform plan -input=false -no-color \\
  -replace=local_file.release -out=replace.tfplan
terraform show -json replace.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["delete", "create"]
'
replace_before_filename="$(terraform show -json replace.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.before.filename')"
replace_after_filename="$(terraform show -json replace.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.after.filename')"
test "$(realpath -m -- "$replace_before_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
test "$(realpath -m -- "$replace_after_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform show -json replace.tfplan | jq -S '
  .resource_changes[] |
  select(.address == "local_file.release") |
  {address, actions: .change.actions}
' > artifacts/replacement-proof.json
terraform apply -input=false -no-color replace.tfplan`),
    expected: "local_file.release 한 개만 delete/create · replacement proof",
    hint: "Gate가 정확히 한 주소인지 확인한 뒤 saved plan을 apply하세요.",
    troubleshooting: ["Plan에 다른 주소가 보이면 apply하지 말고 구성과 workspace를 확인하세요.", "-replace 주소에는 현재 state의 정확한 주소를 사용하세요."],
    success: "정확히 한 synthetic release만 검토된 replace plan으로 교체했습니다.",
    validate: verify("replace-release", "07-operations", `
test "$(terraform workspace show)" = "stage"
terraform show -json replace.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["delete", "create"]
' >/dev/null
replace_before_filename="$(terraform show -json replace.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.before.filename')"
replace_after_filename="$(terraform show -json replace.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.after.filename')"
test "$(realpath -m -- "$replace_before_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
test "$(realpath -m -- "$replace_after_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
jq -e '. == {
  "actions": ["delete", "create"],
  "address": "local_file.release"
}' artifacts/replacement-proof.json >/dev/null
test "$(terraform state list)" = "local_file.release"
jq -e '. == {"version":"v1","workspace":"stage"}' artifacts/stage/release.json >/dev/null
`),
    expect: [marker("replace-release")],
    skipSetup: fixture("replace-release", "07-operations", operationsReplaced),
  },
  {
    id: "refresh-only",
    lab: 7,
    title: "Refresh-only state 동기화",
    objective: "수동 drift를 refresh-only plan으로 관찰하고 실제 파일을 변경하지 않은 채 state만 갱신합니다.",
    description: "Release 파일을 수동 변경한 뒤 refresh-only saved plan을 검토하고 적용하세요.",
    concept: "Refresh-only는 구성을 실제 환경에 강제하지 않고 관측된 상태를 state와 output에 반영합니다.",
    command: publicCommand("07-operations", `terraform workspace select stage >/dev/null
printf '%s\\n' '{"workspace":"stage","version":"manual-drift"}' \\
  > artifacts/stage/release.json
terraform plan -refresh-only -input=false -no-color \\
  -out=refresh-only.tfplan
terraform show -json refresh-only.tfplan | jq -e '
  [.resource_drift[]?] as $drift |
  ($drift | length) == 1 and
  $drift[0].mode == "managed" and
  $drift[0].address == "local_file.release" and
  $drift[0].change.actions == ["delete"]
'
refresh_filename="$(terraform show -json refresh-only.tfplan |
  jq -er '.resource_drift[] | select(.address == "local_file.release") | .change.before.filename')"
test "$(realpath -m -- "$refresh_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform apply -input=false -no-color refresh-only.tfplan`),
    expected: "resource drift delete 관측 · 실제 manual file 유지 · state만 갱신",
    hint: "refresh-only plan에는 일반 create/update를 섞지 마세요.",
    troubleshooting: ["Drift가 보이지 않으면 파일 내용과 현재 workspace를 확인하세요.", "일반 plan을 만들었다면 적용하지 말고 -refresh-only로 다시 저장하세요."],
    success: "실제 객체를 고치지 않고 관측된 drift만 state에 반영했습니다.",
    validate: verify("refresh-only", "07-operations", `
test "$(terraform workspace show)" = "stage"
terraform show -json refresh-only.tfplan | jq -e '
  [.resource_drift[]?] as $drift |
  ($drift | length) == 1 and
  $drift[0].mode == "managed" and
  $drift[0].address == "local_file.release" and
  $drift[0].change.actions == ["delete"]
' >/dev/null
refresh_filename="$(terraform show -json refresh-only.tfplan |
  jq -er '.resource_drift[] | select(.address == "local_file.release") | .change.before.filename')"
test "$(realpath -m -- "$refresh_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
test -z "$(terraform state list)"
jq -e '. == {"version":"manual-drift","workspace":"stage"}' artifacts/stage/release.json >/dev/null
`),
    expect: [marker("refresh-only")],
    skipSetup: fixture("refresh-only", "07-operations", operationsRefreshed),
  },
  {
    id: "safe-destroy",
    lab: 7,
    title: "최종 saved destroy plan gate",
    objective: "State를 복구한 뒤 정확히 한 local resource의 saved destroy plan만 적용합니다.",
    description: "Stage release를 재관리하고 destroy plan JSON gate를 통과한 뒤 안전하게 정리하세요.",
    concept: "Destroy plan도 immutable review artifact입니다. Gate와 apply 사이에 새 plan을 만들지 않아야 검토 계약이 유지됩니다.",
    command: publicCommand("07-operations", `terraform workspace select stage >/dev/null
terraform plan -input=false -no-color -out=recreate.tfplan
terraform show -json recreate.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  ($managed[0].change.after.content | fromjson) == {
    "version": "v1",
    "workspace": "stage"
  }
'
recreate_filename="$(terraform show -json recreate.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.after.filename')"
test "$(realpath -m -- "$recreate_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform apply -input=false -no-color recreate.tfplan
terraform plan -destroy -input=false -no-color \\
  -out=safe-destroy.tfplan
terraform show -json safe-destroy.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["delete"]
'
safe_destroy_filename="$(terraform show -json safe-destroy.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.before.filename')"
test "$(realpath -m -- "$safe_destroy_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform apply -input=false -no-color safe-destroy.tfplan`),
    expected: "JSON gate 통과 · local_file.release delete 1개 · state empty",
    hint: "terraform apply safe-destroy.tfplan은 JSON gate 뒤에 한 번만 실행하세요.",
    troubleshooting: ["두 개 이상의 managed change가 있으면 절대 apply하지 마세요.", "Saved plan is stale이면 현재 state를 확인하고 plan부터 다시 검토하세요."],
    success: "최종 synthetic release를 검토된 destroy plan으로 안전하게 정리했습니다.",
    validate: verify("safe-destroy", "07-operations", `
test "$(terraform workspace show)" = "stage"
terraform show -json recreate.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  ($managed[0].change.after.content | fromjson) == {
    "version": "v1",
    "workspace": "stage"
  }
' >/dev/null
recreate_filename="$(terraform show -json recreate.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.after.filename')"
test "$(realpath -m -- "$recreate_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
terraform show -json safe-destroy.tfplan | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.release" and
  $managed[0].change.actions == ["delete"]
' >/dev/null
safe_destroy_filename="$(terraform show -json safe-destroy.tfplan |
  jq -er '.resource_changes[] | select(.address == "local_file.release") | .change.before.filename')"
test "$(realpath -m -- "$safe_destroy_filename")" = \
  "$resolved_project/artifacts/stage/release.json"
test -z "$(terraform state list)"
test ! -e artifacts/stage/release.json
`),
    expect: [marker("safe-destroy")],
    skipSetup: fixture("safe-destroy", "07-operations", operationsDestroyed),
  },
  {
    id: "agent-skills-catalog",
    lab: 8,
    title: "Agent Skills 개념과 공식 Catalog 확인",
    objective: "Agent Skill을 Terraform Provider·CLI plugin·MCP와 구분하고 공식 Terraform Skill 16개의 출처와 역할을 확인합니다.",
    description: "고정된 HashiCorp Agent Skills 스냅샷의 commit, 라이선스, lifecycle과 Terraform Skill 목록을 조사하세요.",
    concept: "HashiCorp Agent Skills는 호환되는 AI 코딩 에이전트가 작업에 맞춰 읽는 버전 관리된 SKILL.md 지침 패키지입니다. 구성·테스트·Import·Stacks·Policy·Module·Azure와 Provider 생성·인증·리소스·Action·Ephemeral·Migration·문서·Acceptance Test까지 16개 역할을 제공합니다. Skill 자체가 Terraform을 대신 실행하거나 권한을 제공하지는 않지만, 이를 사용하는 에이전트는 지침에 포함된 명령·스크립트를 실행할 수 있으므로 검토와 sandbox가 필요합니다. 이 Lab은 정식 tag가 아닌 검토된 Unreleased main commit을 고정하며 외부 LLM/API key는 실행하지 않습니다.",
    command: publicCommand("08-agent-skills", `${agentSkillsCatalogReady}
cat artifacts/catalog-summary.json
jq '.skills[] | {name, category, capability, use_when}' artifacts/skill-capabilities.json`),
    expected: `Unreleased main ${AGENT_SKILLS_COMMIT.slice(0, 12)} · Terraform Skill 16개의 기능·사용 시점 · MPL-2.0`,
    hint: "Skill 이름뿐 아니라 upstream commit과 root-owned manifest가 함께 고정됐는지 확인하세요.",
    troubleshooting: ["snapshot 경로가 없으면 새 승인 AMI 후보에 native installer가 완료됐는지 확인하세요.", "manifest mismatch가 나오면 사용하지 말고 배포 artifact와 upstream pin을 다시 검토하세요."],
    success: "Terraform Agent Skills 16개와 재현 가능한 upstream provenance를 확인했습니다.",
    validate: verify("agent-skills-catalog", "08-agent-skills", `
${agentSkillsSnapshotVerified}
test -s artifacts/terraform-skills.txt
test "$(cat artifacts/terraform-skills.txt)" = "$expected_agent_skill_names"
test "$(jq -r '.skills | join("\\n")' artifacts/catalog-summary.json)" = \
  "$expected_agent_skill_names"
capabilities_validation_dir="$(mktemp -d)"
trap 'find "$capabilities_validation_dir" -xdev -mindepth 1 -delete; rmdir "$capabilities_validation_dir"' EXIT HUP INT TERM
cat > "$capabilities_validation_dir/expected-skill-capabilities.json" <<'TFLAB_EXPECTED_CAPABILITIES'
${agentSkillCapabilitiesJson.trim()}
TFLAB_EXPECTED_CAPABILITIES
cmp -s artifacts/skill-capabilities.json \
  "$capabilities_validation_dir/expected-skill-capabilities.json"
jq -e '
  .source_repository == "${AGENT_SKILLS_REPOSITORY}" and
  .source_commit == "${AGENT_SKILLS_COMMIT}" and
  .source_kind == "unreleased-main-snapshot" and
  .agent_execution == "not-run-in-this-offline-lab" and
  (.skills | length) == 16 and
  ([.skills[].name] | join("\\n")) == $expected and
  ([.skills[].category] | unique | length) >= 7
' --arg expected "$expected_agent_skill_names" \
  artifacts/skill-capabilities.json >/dev/null
jq -e '
  .repository == "${AGENT_SKILLS_REPOSITORY}" and
  .commit == "${AGENT_SKILLS_COMMIT}" and
  .source_kind == "unreleased-main-snapshot" and
  .product == "terraform" and
  .lifecycle == "active" and
  .skill_count == 16 and
  .agent_execution == "not-run-in-this-offline-lab" and
  (.skills | length) == 16
' artifacts/catalog-summary.json >/dev/null
`),
    expect: [marker("agent-skills-catalog")],
    skipSetup: fixture("agent-skills-catalog", "08-agent-skills", agentSkillsCatalogReady),
  },
  {
    id: "agent-skills-select",
    lab: 8,
    title: "작업에 맞는 Skill 조합 선택",
    objective: "일반 프롬프트 대신 작업 목적에 맞는 Skill을 명시적으로 선택하고 설치 경로를 기록합니다.",
    description: "스타일, 테스트, Module 리팩터링에 필요한 세 Skill과 선택 이유를 project manifest로 만드세요.",
    concept: "한 제품 bundle에는 여러 Skill이 포함되지만 에이전트는 현재 작업에 필요한 최소 지침만 읽는 것이 효율적입니다. 공식 온라인 설치는 npx skills 또는 호환 에이전트의 repository marketplace를 사용합니다. 네트워크가 차단된 이 Lab에서는 검증된 스냅샷을 사용하고 설치 계획만 project manifest로 남깁니다.",
    command: publicCommand("08-agent-skills", `${agentSkillsSelectionReady}
cat selection.json`),
    expected: "refactor-module · terraform-style-guide · terraform-test의 공식 경로와 선택 목적",
    hint: "Skill 이름과 plugins/terraform/skills/<name> 경로가 정확히 대응해야 합니다.",
    troubleshooting: ["선택한 이름이 catalog에 없으면 artifacts/terraform-skills.txt를 다시 확인하세요.", "JSON 오류가 나면 jq -e . selection.json으로 먼저 문법을 검사하세요."],
    success: "현재 Terraform 작업에 필요한 최소 Skill 조합과 설치 경로를 정의했습니다.",
    validate: verify("agent-skills-select", "08-agent-skills", `
${agentSkillsSnapshotVerified}
jq -e '
  [.skills[].name] == [
    "refactor-module",
    "terraform-style-guide",
    "terraform-test"
  ] and
  [.skills[].installation_path] == [
    "plugins/terraform/skills/refactor-module",
    "plugins/terraform/skills/terraform-style-guide",
    "plugins/terraform/skills/terraform-test"
  ] and
  ([.skills[].purpose] | all(type == "string" and length > 20))
' selection.json >/dev/null
expected_selection_report="$(
  jq -r '.skills[] | [.name, .purpose] | @tsv' selection.json
)"
test "$(cat artifacts/selection-report.tsv)" = "$expected_selection_report"
jq -r '.skills[].name' selection.json | while IFS= read -r agent_skill; do
  test -f "$snapshot_root/plugins/terraform/skills/$agent_skill/SKILL.md"
done
`),
    expect: [marker("agent-skills-select")],
    skipSetup: fixture("agent-skills-select", "08-agent-skills", agentSkillsSelectionReady),
  },
  {
    id: "agent-skills-install",
    lab: 8,
    title: "Project-local Skill bundle 설치",
    objective: "검증된 read-only source에서 선택한 Skill을 project-local .agents/skills로 설치하고 무결성 manifest를 만듭니다.",
    description: "선택한 세 Skill의 SKILL.md와 references를 외부 네트워크 없이 현재 project에 설치하세요.",
    concept: "Project-local 설치는 저장소와 함께 필요한 지침을 명시하고 다른 프로젝트에 불필요한 Skill이 섞이는 것을 줄입니다. 원본은 root-owned read-only이며 학습자 사본만 쓰기 가능합니다. 설치 후 SHA-256 manifest와 upstream commit을 함께 남깁니다. 이 경로는 호환 에이전트가 발견할 수 있지만 이 offline Lab 자체는 에이전트나 LLM을 실행하지 않습니다.",
    command: publicCommand("08-agent-skills", `${agentSkillsInstallReady}
jq . artifacts/installation.json`),
    expected: ".agents/skills 아래 3개 Skill · upstream commit 기록 · 전체 파일 SHA-256 검증",
    hint: "원본 디렉터리를 수정하지 말고 project-local 사본과 설치 manifest를 확인하세요.",
    troubleshooting: ["permission denied이면 root-owned 원본이 아니라 project-local 경로를 수정 중인지 확인하세요.", "checksum 실패 시 사본을 임의로 고치지 말고 설치 단계를 다시 실행하세요."],
    success: "선택한 Agent Skills를 출처와 무결성이 확인되는 project bundle로 설치했습니다.",
    validate: verify("agent-skills-install", "08-agent-skills", agentSkillsInstallVerified),
    expect: [marker("agent-skills-install")],
    skipSetup: fixture("agent-skills-install", "08-agent-skills", agentSkillsInstallReady),
  },
  {
    id: "agent-skills-guided-test",
    lab: 8,
    title: "Skill 지침을 Terraform 검증으로 증명",
    objective: "Style Guide와 Terraform Test 지침을 코드 구조에 적용하고 기계적 검증 결과로 완료를 판정합니다.",
    description: "파일 분리, 입력 validation, 안전한 file mode, plan assertion을 갖춘 구성을 만들고 terraform test를 통과시키세요.",
    concept: "Agent의 자연어 답변만으로 품질을 판정하면 재현할 수 없습니다. 이 단계는 외부 에이전트를 호출하지 않고 Skill-guided 산출물 계약을 offline reference fixture로 재현합니다. 실제 에이전트 사용 시에도 최종 결과는 terraform fmt -check, validate, plan JSON, terraform test처럼 결정적인 도구로 다시 검증해야 합니다. Agent Skill 자체는 AWS 권한이나 자격 증명을 부여하지 않습니다.",
    command: publicCommand("08-agent-skills", `${agentSkillsGuidedTestReady}
cat artifacts/terraform-test.txt
cat artifacts/guided-review.json`),
    expected: "fmt check · validate · plan contract · terraform test 1 passed",
    hint: "SKILL.md 존재 여부가 아니라 지침을 적용한 HCL과 test의 실제 동작을 검증하세요.",
    troubleshooting: ["fmt check가 실패하면 terraform fmt를 실행하고 파일 차이를 확인하세요.", "terraform test 실패 시 tests/agent-guided.tftest.hcl의 assertion과 plan 값을 비교하세요."],
    success: "Agent Skills가 안내한 코드 구조와 테스트 계약을 실제 Terraform CLI로 검증했습니다.",
    validate: verify("agent-skills-guided-test", "08-agent-skills", `
${agentSkillsInstallVerified}
test -f versions.tf
test -f variables.tf
test -f main.tf
test -f outputs.tf
test -f tests/agent-guided.tftest.hcl
terraform fmt -check -no-color >/dev/null
terraform validate -no-color >/dev/null
validation_dir="$(mktemp -d)"
trap 'find "$validation_dir" -xdev -mindepth 1 -delete; rmdir "$validation_dir"' EXIT HUP INT TERM
cat > "$validation_dir/expected-agent-guided.tftest.hcl" <<'TFLAB_EXPECTED_TEST'
${agentGuidedTest.trim()}
TFLAB_EXPECTED_TEST
cmp -s tests/agent-guided.tftest.hcl \
  "$validation_dir/expected-agent-guided.tftest.hcl"
terraform plan -input=false -no-color -var=environment=stage \
  -out="$validation_dir/agent-guided.tfplan" >/dev/null
terraform show -json "$validation_dir/agent-guided.tfplan" | jq -e '
  [.resource_changes[]? | select(.mode == "managed")] as $managed |
  ($managed | length) == 1 and
  $managed[0].address == "local_file.agent_review" and
  $managed[0].change.actions == ["create"] and
  $managed[0].change.after.file_permission == "0600" and
  ($managed[0].change.after.content | fromjson) == {
    "environment": "stage",
    "managed_by": "Terraform Agent Skills"
  }
' >/dev/null
planned_filename="$(terraform show -json "$validation_dir/agent-guided.tfplan" |
  jq -er '.resource_changes[] | select(.address == "local_file.agent_review") | .change.after.filename')"
test "$(realpath -m -- "$planned_filename")" = \
  "$resolved_project/artifacts/stage-agent-review.json"
terraform test -no-color > "$validation_dir/terraform-test.txt"
grep -Fq 'Success!' "$validation_dir/terraform-test.txt"
grep -Fq '1 passed, 0 failed' "$validation_dir/terraform-test.txt"
grep -Fq 'Success!' artifacts/terraform-test.txt
jq -e '
  .source_commit == "${AGENT_SKILLS_COMMIT}" and
  .guidance == ["terraform-style-guide", "terraform-test"] and
  .execution_mode == "offline-reference-fixture" and
  .agent_invoked == false and
  .format_check == "passed" and
  .validation == "passed" and
  .terraform_test == "passed"
' artifacts/guided-review.json >/dev/null
test -z "$(terraform state list 2>/dev/null)"
`),
    expect: [marker("agent-skills-guided-test")],
    skipSetup: fixture("agent-skills-guided-test", "08-agent-skills", agentSkillsGuidedTestReady),
  },
];
