# GitHub Actions workflows

## `interop.yml` — MoQ wire-format interop matrix

The `interop.yml` workflow runs moq-web against reference MoQ implementations to
prove our wire codec is compatible with peers in the ecosystem. The matrix
covers:

| implementation | role       | peer repo                    |
| -------------- | ---------- | ---------------------------- |
| moq-rs         | publisher  | github.com/kixelated/moq-rs  |
| moq-rs         | subscriber | github.com/kixelated/moq-rs  |
| libquicr       | publisher  | github.com/Quicr/libquicr    |
| libquicr       | subscriber | github.com/Quicr/libquicr    |

Each cell pairs moq-web against the peer in the opposite role: when the peer is
`publisher`, moq-web runs as `subscriber`, and vice versa. The scenario runs the
harness at `scripts/interop-harness.sh` — see that file for the input/output
contract.

### Current status: **gated (`if: false`)**

The workflow file exists with the matrix wired up, but the top-level job is
gated behind `if: false` until the scenario harness is complete. Wave 2 landed
the workflow scaffolding; enabling it end-to-end requires the follow-up items
below.

### Enabling interop

To flip `if: false` → `if: true` (or remove the gate) the following pieces
still need to land:

1. **Fill in `scripts/interop-harness.sh`.** The current file is a
   documented skeleton — it declares the env-var contract, exit-code
   semantics, and the sequence of steps the harness will take, but does not
   actually spawn the peer binary, boot the moq-web sample, or verify object
   receipt. Wire in:
   - Boot the peer binary in the requested role (relay or client mode as
     appropriate for `moq-rs` / `libquicr`).
   - Boot the moq-web sample (`samples/relay-echo` or a dedicated interop
     entry point in `apps/`) in the opposite role with the same track
     namespace and target object count.
   - Wait for the subscriber side to receive `$OBJECT_COUNT` objects in
     order; exit 0 on success, non-zero on timeout / mismatch.

2. **Pin the peer refs.** The matrix currently uses `peer_ref: main` for both
   `moq-rs` and `libquicr` to keep the initial wiring simple. Once the harness
   is working, pin each to a specific commit SHA (recorded in this README and
   in the workflow file) so interop drift shows up in this workflow rather
   than in a random PR.

3. **Pin a libquicr build recipe.** The current `cmake -S . -B build && cmake
   --build build --config Release` invocation assumes libquicr's top-level
   CMakeLists supports that form and that all deps are fetched by CMake. If
   libquicr requires `--recurse-submodules` or a specific dependency pin
   (BoringSSL, picoquic, etc.), record it here and update the `Clone peer
   implementation` step accordingly.

4. **Sample harness entry point.** moq-web currently ships session/media
   packages but no headless CLI. The harness likely needs a small
   `apps/interop-cli` or `packages/interop/bin/` that:
   - Accepts `--role publisher|subscriber`, `--url`, `--namespace`, `--track`,
     `--count`, `--duration` flags.
   - Publishes a fixed 10-object track for 5 seconds, or subscribes and
     asserts 10 objects arrive in order.
   - Exits 0 on success.

5. **Firewall / port allocation.** Both peer implementations bind QUIC UDP
   sockets. On GitHub Actions runners, ephemeral ports are fine, but the
   harness should pass explicit port numbers between publisher and subscriber
   so the two sides can find each other deterministically.

Once (1)-(5) are landed, remove `if: false` from `interop.yml` and this
workflow will run on every PR to `main`.

### Debugging interop failures

Each failed job uploads `/tmp/interop-*.log` as a build artifact
(`interop-logs-<impl>-<role>`). The harness is expected to write:
- `/tmp/interop-peer.log` — peer stdout/stderr
- `/tmp/interop-moqweb.log` — moq-web stdout/stderr
- `/tmp/interop-scenario.log` — the harness's own step-by-step log

Add more logs as the harness grows; the workflow uploads all `/tmp/interop-*.log`.
