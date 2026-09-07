# Native Terraform Lab runtime

This runtime runs Terraform exercises without Docker. A fixed pool of Amazon
Linux 2023 users is provisioned at install time and every session receives a
separate 1 GiB ext4 filesystem mounted `nodev,nosuid,noexec`.

## Security boundary

- `terraform-lab` is the unprivileged web identity.
- `tflab-s01` through the configured slot count are fixed learner identities.
- `/usr/local/sbin/terraform-lab-control` is root-owned and is the only
  privileged transition available through a pinned sudoers rule.
- Terminal and curriculum commands run in transient systemd services with no
  capabilities, no network access, a read-only host, bounded CPU/memory/PIDs,
  and writable access only to the slot's `home` and `tmp` directories.
- Verify and skip commands freeze the learner terminal, validate the session
  generation under the slot lock, and execute trusted curriculum argv as the
  same learner UID. This prevents a terminal race without giving the validator
  a second identity with ambient authority.
- A release is activated only after its compiled native curriculum smoke runs
  all 34 learner commands and exact validators. Two alternating skip chains
  cover every skip fixture and every skip-to-next-command transition.
- A root reaper and the Node janitor independently reset expired slots. Stale
  reaper work includes both generation and observed expiry, so an extension or
  reassignment is not destroyed.

## Terraform and providers

The installer pins Terraform `1.15.8` and constructs the unpacked, root-owned
filesystem mirror `/opt/terraform-lab/providers` containing only:

- `hashicorp/local` `2.5.3`
- `hashicorp/random` `3.7.2`
- `hashicorp/null` `3.2.4`
- `hashicorp/tls` `4.1.0`

Provider ZIPs, SHA256SUMS, and detached signatures are downloaded over TLS from
`releases.hashicorp.com`. The official release key document is hash-pinned,
each checksum manifest signature is verified, and the exact archive hash and
safe single-binary archive shape are checked before installation. A root-owned
SHA-256 manifest covers the four unpacked binaries. The CLI configuration contains no `direct` installation
method, and checkpoint, interactive input, AWS metadata, and inherited AWS
credentials are disabled in terminal and validator environments.

The final installer smoke creates provider symlinks from a `noexec` learner
filesystem to the executable read-only mirror and proves `terraform init`,
`plan`, and `show -json` work before the runtime is accepted.

## HashiCorp Agent Skills

The installer fetches the official `hashicorp/agent-skills` repository at
commit `4451ceca5456e79cc776efee96a744f7ac96e5bf`. This is an explicitly pinned
`main` snapshot whose integrated 16-Skill/plugin structure was `Unreleased` at
the snapshot date, not a floating branch or release tag. It verifies the exact Git
object, the 16 active Terraform Skill names, frontmatter, symlink-free plugin
tree, support documentation, and MPL-2.0 license before installing the complete product plugin
snapshot at `/opt/terraform-lab/agent-skills`. Every file is root-owned and
covered by a SHA-256 manifest; learner systemd scopes mount the path read-only
and remain network-denied.

Learners copy only the selected Skill directories into the current project's
`.agents/skills` directory, which a compatible agent can discover. The catalog
artifact explains the capability and use case of all 16 Skills. No upstream
script, `npx` installer, LLM, or cloud credential is executed or provided by
the Lab; the final exercise uses an explicit offline reference fixture instead
of claiming an agent invocation. A real agent may execute commands or bundled
scripts described by a Skill, so those actions still require review and a
sandbox. Curriculum validators compare the project copy to the immutable
snapshot and verify the resulting Terraform configuration with `fmt -check`,
`validate`, plan JSON, and `terraform test`.

## Install

```bash
sudo NATIVE_SLOT_COUNT=4 ./infra/terraform-native-install.sh
```

The host must be an approved Amazon Linux 2023 x86_64 AMI. The EC2 deployment
layer is responsible for owner/name/AMI-ID enforcement, encrypted EBS, IMDSv2,
an SSM-only role, and a security group without SSH.
