# Native Vault Lab runtime

This runtime replaces Docker with a fixed pool of native Linux users and
on-demand systemd services on Amazon Linux 2023.

## Isolation model

- Each active lab is assigned separate learner, verifier, and Vault service UIDs
  (`vaultlab-s01`, `vaultverify-s01`, and `vaultsvc-s01`).
- Every slot uses a root-owned, preallocated 512 MiB ext4 image with a fixed
  inode budget and `nodev,nosuid,noexec`; one learner cannot exhaust the host
  filesystem for every session.
- Vault alone receives `CAP_NET_BIND_SERVICE` and listens on the fixed
  privileged `127.77.0.<slot>:820/821` endpoints. Learners cannot signal the
  daemon or replace a failed endpoint with a fake server.
- Vault and terminal/validator commands run in separate hardened systemd units.
- CPU, memory, process count, file descriptors, writable paths, Linux
  capabilities, syscalls, and network destinations are bounded.
- The AWS metadata service and outbound internet are unavailable inside labs;
  only loopback is permitted.
- A root-owned sticky session `/tmp` preserves curriculum artifacts. The
  controller transfers only an exact per-step basename allowlist between
  learner and verifier UIDs, rejecting links and unsafe ownership.
- Every session generation receives a fresh random 32-hex binding, including
  after a reset by the same learner. Terminal and verifier requests carry that
  internal nonce; it is not part of the public session response. The root
  controller checks its app-owned `session-id` commit file while holding the
  slot lock, so a stale request cannot attach after reset or reassignment.
- The file audit device is installed by trusted bootstrap with
  `log_raw=false`; learner policy can inspect but cannot add, modify, or remove
  audit devices.
- Vault performs a normal `sys/init` and receives a randomized root token. No
  fixed development token or `-dev` server is used.
- Root tokens live in `/run` only, mode `0600`, and disappear on reboot. The
  unseal key is intentionally not persisted.
- The terminal receives a separate short-lived `lab-student` token. Trusted
  validators receive the root token through a one-shot systemd credential, so
  students cannot read it from the filesystem or process environment.
- The Node janitor and an independent systemd timer both enforce expiry.
  Reaper requests include the observed session ID and expiry; extension first
  commits a lock-coordinated expiry guard so stale reaper work is a no-op.

## Install

From the Git checkout on an Amazon Linux 2023 EC2 host:

```bash
sudo NATIVE_SLOT_COUNT=4 VAULT_VERSION=2.0.3 ./infra/native-install.sh
```

The production installer defaults to this tested version. Set another explicit
`VAULT_VERSION` only when intentionally validating a newer signed HashiCorp RPM.
The Node application must run as `vault-lab`; it receives narrowly scoped sudo
access to the root-owned validating control helper, not to `systemctl` or a
shell.

## Server integration

`server/native-runtime.ts` exports `NativeVaultRuntime`:

```ts
const runtime = new NativeVaultRuntime({
  maxSessions: 4,
  sessionTtlMs: 4 * 60 * 60 * 1_000
});
await runtime.initialize();
runtime.startJanitor();

const session = await runtime.getOrCreate(sessionId);
const result = await runtime.execute(sessionId, step.validate, {
  operation: "verify",
  stepId: step.id
});
const terminal = await runtime.openTerminal(sessionId);

terminal.output.on("data", (data) => ws.send(data));
terminal.errorOutput.on("data", (data) => ws.send(data));
ws.on("message", (data) => terminal.write(data as Buffer));
ws.on("close", () => terminal.close());
```

Call `runtime.reset(id)` to rebuild a session in place, `runtime.destroy(id)` to
release it, `runtime.extend(id, additionalMs)` to extend it up to 24 hours from
the current time, and `runtime.close()` during graceful application shutdown.

The runtime is deliberately single-owner. `initialize()` acquires a lock under
`/run/vault-lab/app`; a second Node process refuses to allocate slots. Run one
application process per EC2 instance, or introduce an external coordinator
before scaling the web tier horizontally.
