# HashiCorp Native Training Labs

[한국어](README.md) · [English](README.en.md)

## Purpose

A browser-based Vault and Terraform training platform with Korean lessons, a web terminal, server-side validation, and instructor session management.

## Benefits

- Keep lesson text, terminal commands, and validation feedback in one workflow.
- Track successful checks, failures, skips, and progress for each learner.
- Practice commands in environments isolated with Linux users and systemd.

## Features and structure

- React/Vite frontend, Express/WebSocket server, and YAML curriculum
- Vault: 7 core labs and 30 validation steps covering KV, policies, AppRole, Transit, Audit, and PKI
- Terraform: 8 labs and 34 steps covering plan/apply, state, modules, tests, and workspaces
- Pinned Terraform CLI and an offline provider mirror
- Learner, instructor, and administrator roles; invitations, session TTL, progress, and audit records
- Native exercises run on dedicated EC2 hosts without a container runtime

## Getting started

Use the Node.js and npm versions in `package.json`. Start with local mock mode, which does not execute real shell commands.

```bash
npm ci
MOCK_LAB=true \
AUTH_COOKIE_SECRET=mock-only-auth-cookie-secret-2026-change-me \
npm run dev
```

Mock administrator: `admin@vault-lab.local` / `LocalAdminPassword!2026`. These are local-only example credentials. Add `COURSE_ID=terraform-foundations` for Terraform; its mock administrator email is `admin@terraform-lab.local`.

```bash
npm test
npm run build
```

## Documentation

- [Installation and operations (Korean)](OPERATIONS.ko.md)
- [Vault native runtime](infra/native/README.en.md)
- [Terraform operating contract](docs/terraform-lab.md)
- [Terraform native runtime](infra/terraform-native/README.en.md)
- [Desktop design](design/README.en.md)

## Scope and limitations

Mock checks do not validate real Vault or Terraform execution. Native deployment requires approved AMI access, dedicated networking/IAM, HTTPS, and a strong cookie-signing secret. The deployment script enforces an AMI owner/name/architecture allowlist; arbitrary AWS images are not accepted. EC2, storage, and networking incur costs. Courses requiring external integrations need additional sandboxes.
