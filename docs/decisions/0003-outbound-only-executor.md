# 0003. The executor polls outbound and never listens

**Status:** Accepted

## Context

The executor runs on a personal WSL development machine with access to source
trees, git credentials, `gh`, and an agent that can run arbitrary commands. The
coordinator must be able to hand it work.

## Decision

The executor **never listens on a port**. It long-polls the coordinator over
authenticated outbound HTTPS: `claim` with a bounded wait, `heartbeat` while
working, then `result`, `cancel-ack` or `failure`.

The `@ducky/executor` package has no server dependency, and a test asserts its
sources contain no `createServer` or `listen(`.

## Alternatives considered

- **An inbound port with a tunnel.** Any inbound path to a machine holding
  credentials and an unsandboxed agent is exactly the exposure worth avoiding,
  and it needs port forwarding, certificates and a stable address.
- **A message broker.** Another service to run and secure for one consumer.
- **SSH from the coordinator.** Inbound again, and it would put a key with shell
  access on the cloud host.

## Consequences

WSL has no attack surface from the network. NAT, sleep and address changes stop
mattering — the client backs off with jitter and resumes. The cost is polling
latency, bounded by the long-poll wait, and a lease/reservation model to detect
an executor that vanished mid-job.
