# GitHub Actions workflows

## `interop.yml` — MoQ wire-format interop matrix

The `interop.yml` workflow runs moq-web against reference MoQ implementations to
prove our wire codec is compatible with peers in the ecosystem. The matrix
covers:

| implementation | role       | peer repo                    |
| -------------- | ---------- | ---------------------------- |
| moq-rs         | publisher  | github.com/kixelated/moq     |
| moq-rs         | subscriber | github.com/kixelated/moq     |
| libquicr       | publisher  | github.com/Quicr/libquicr    |
| libquicr       | subscriber | github.com/Quicr/libquicr    |

Each cell pairs moq-web against the peer in the opposite role: when the peer is
`publisher`, moq-web runs as `subscriber`, and vice versa. The scenario runs the
harness at `scripts/interop-harness.sh` — see that file for the input/output
contract.

### Current status: **gated (`if: false`)**

Wave 2 landed the workflow scaffolding, Wave 3 filled in the harness, CLI,
peer pins, build recipes, and port allocation. The workflow is now one line
away from being live — see [`if: false`](interop.yml) inside the `interop`
job. Before flipping the gate, walk the [checklist below](#remaining-before-flipping-gate).

### Done (Wave 3 track K)

1. **`scripts/interop-harness.sh` implemented.** Boots the peer binary and
   the moq-web CLI, waits for `OBJECT_COUNT` `OBJECT groupId=… objectId=…`
   lines in the subscriber-side log within `DURATION_SECONDS + 10s`, and
   handles cleanup via an `EXIT` trap. Exit codes 0/1/2 are honoured; a
   `DRY_RUN=1` mode substitutes shell stubs so the pipeline can be smoke-
   tested end-to-end without pulling the peer binaries.
2. **Peer refs pinned.** `interop.yml` pins:
   - `kixelated/moq` @ `863f55ca44f6a19166bb652f02e2eb83730d0786` (main
     as of 2026-09-21). Build: `cd rs && cargo build --release -p moq-cli
     -p moq-relay`.
   - `Quicr/libquicr` @ `09d0a30abeae0345667b3f13c390a17e9c572950` (main
     as of 2026-09-21). Build: `git submodule update --init --recursive &&
     make` (matches the upstream README's canonical recipe).
3. **libquicr build recipe expanded.** Apt-install now includes `gcc-12`,
   `g++-12`, `libssl-dev`, `pkg-config`, `ninja-build`, `golang`, and
   `clang-tidy-15` per the upstream `README.md` § "Ubuntu 22.04 Jammy".
   Submodules (`picoquic`, `mbedtls`, `timeq`) are fetched inside the peer
   build step. `CC`/`CXX` are pinned to the gcc-12 pair via `$GITHUB_ENV`.
4. **moq-web interop CLI.** New at
   `packages/session/src/cli/interop-cli.ts`, wired as the
   `moq-web-interop` bin in `packages/session/package.json`. Guards
   against Node runtimes that lack a `WebTransport` global (exits 2 with
   an actionable message). Full flag set: `--role`, `--url`,
   `--namespace`, `--track`, `--object-count`, `--duration`. Object log
   format is `OBJECT groupId=… objectId=… bytes=…` which
   `interop-harness.sh` greps for. Unit tests at
   `packages/session/src/cli/interop-cli.test.ts`.
5. **Port allocation.** Each of the 4 matrix cells has its own
   `relay_port` / `moqweb_port` pair (4443–4446), plumbed through
   `MOQ_RELAY_PORT`, `MOQ_WEB_PORT`, and `PUBLISHER_URL` env vars into
   the harness. No two cells share a UDP port so parallel runners can't
   collide.

### Remaining before flipping gate

The five foundational items are done; what's left is real-world
verification that we can't do without actually running the workflow in CI
against the pinned peers. A reviewer should walk this list before opening
the "flip `if: false` → `if: true`" PR:

- [ ] Confirm the `cd rs && cargo build --release -p moq-cli -p moq-relay`
      recipe still builds cleanly at the pinned `moq` SHA — the crate
      layout under `rs/` is relatively new.
- [ ] Verify `moq-cli`'s actual flag set matches what the harness passes
      (`--connect`, `--broadcast`, `import ts` / `export ts`). If
      upstream renamed a flag, either update the harness invocation or
      pin an older SHA.
- [ ] Verify `qclient`'s CLI matches the harness (`--relay`, `--port`,
      `--pub_namespace` / `--sub_namespace`, `--pub_name` /
      `--sub_name`, `--clock`) at the pinned libquicr SHA.
- [ ] Confirm the Ubuntu-22.04 GHA runner can install `gcc-12`,
      `clang-tidy-15`, and `golang` in one apt transaction. If the
      default runner image is 24.04 the version-suffixed packages may
      differ.
- [ ] Provide a Node WebTransport shim for the interop CLI. Today the
      CLI aborts with exit 2 when `typeof WebTransport === 'undefined'`;
      in CI we need either a Playwright wrapper (headless Chromium
      already exposes WebTransport) or a polyfill like
      `@fails-components/webtransport` installed as a workflow-only
      dependency. Track this separately — it is the biggest gap.
- [ ] Once the above are green, remove the `if: false` and add a
      `workflow_dispatch` trigger so the matrix can be re-run on demand.

### Debugging interop failures

Each failed job uploads `/tmp/interop-*.log` as a build artifact
(`interop-logs-<impl>-<role>`). The harness writes:
- `/tmp/interop-peer.log` — peer stdout/stderr
- `/tmp/interop-moqweb.log` — moq-web stdout/stderr
- `/tmp/interop-scenario.log` — the harness's own step-by-step log

To reproduce locally with stubs (no peer binaries required):

```sh
DRY_RUN=1 \
  MOQ_WEB_ROOT="$PWD" \
  PEER_ROOT=/tmp \
  IMPLEMENTATION=moq-rs \
  ROLE=publisher \
  TRACK_NAMESPACE=moq-web/interop \
  TRACK_NAME=cell-a \
  OBJECT_COUNT=10 \
  DURATION_SECONDS=5 \
  bash scripts/interop-harness.sh
```
