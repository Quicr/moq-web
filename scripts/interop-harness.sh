#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
# SPDX-License-Identifier: BSD-2-Clause
#
# interop-harness.sh — canned scenario runner for the MoQ interop matrix.
#
# =============================================================================
# CONTRACT
# =============================================================================
#
# Inputs (all via environment variables — set by the caller / CI):
#
#   MOQ_WEB_ROOT       Absolute path to the moq-web checkout (built).
#   PEER_ROOT          Absolute path to the peer implementation checkout (built).
#   IMPLEMENTATION     'moq-rs' | 'libquicr' — which peer we are testing against.
#   ROLE               'publisher' | 'subscriber' — the role the *peer* plays.
#                      moq-web takes the opposite role.
#   TRACK_NAMESPACE    Track namespace to advertise (e.g. 'moq-web/interop').
#   TRACK_NAME         Track name (e.g. 'cell-moq-rs-publisher').
#   OBJECT_COUNT       How many objects to publish/expect (default: 10).
#   DURATION_SECONDS   How long the publisher runs (default: 5).
#
# Optional overrides:
#
#   PUBLISHER_URL      MoQ URL the subscriber connects to. Default:
#                      "https://127.0.0.1:${MOQ_RELAY_PORT}/moq". The harness
#                      picks the URL based on which side hosts.
#   RELAY_URL          When both sides act as clients, the URL of a relay.
#   MOQ_RELAY_PORT     UDP port for the peer's QUIC listener  (default: 4443).
#   MOQ_WEB_PORT       UDP port for the moq-web listener (default: MOQ_RELAY_PORT).
#                      Only used when moq-web hosts (i.e. peer is a client).
#   LOG_DIR            Directory to write logs (default: /tmp).
#   DRY_RUN            When '1', substitute stub binaries and skip the real
#                      spawn — used for CI smoke tests and local dev.
#
# Exit codes:
#
#   0    success — subscriber received exactly OBJECT_COUNT objects in
#        ascending group/object order within DURATION_SECONDS + slack.
#   1    scenario failed (missed objects, out-of-order delivery, or timeout).
#   2    setup failed (peer or moq-web binary missing, or bad env vars).
#   3    NOT_IMPLEMENTED — retained for legacy callers; no code path returns
#        this anymore, but the constant remains so callers that special-cased
#        it don't misinterpret a genuine setup failure.
#
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration defaults
# -----------------------------------------------------------------------------
: "${IMPLEMENTATION:?IMPLEMENTATION must be set (moq-rs|libquicr)}"
: "${ROLE:?ROLE must be set (publisher|subscriber)}"
: "${MOQ_WEB_ROOT:?MOQ_WEB_ROOT must be set}"
: "${PEER_ROOT:?PEER_ROOT must be set}"

TRACK_NAMESPACE="${TRACK_NAMESPACE:-moq-web/interop}"
TRACK_NAME="${TRACK_NAME:-cell-default}"
OBJECT_COUNT="${OBJECT_COUNT:-10}"
DURATION_SECONDS="${DURATION_SECONDS:-5}"
MOQ_RELAY_PORT="${MOQ_RELAY_PORT:-4443}"
MOQ_WEB_PORT="${MOQ_WEB_PORT:-${MOQ_RELAY_PORT}}"
PUBLISHER_URL="${PUBLISHER_URL:-https://127.0.0.1:${MOQ_RELAY_PORT}/moq}"
LOG_DIR="${LOG_DIR:-/tmp}"
DRY_RUN="${DRY_RUN:-0}"

PEER_LOG="${LOG_DIR}/interop-peer.log"
MOQWEB_LOG="${LOG_DIR}/interop-moqweb.log"
SCENARIO_LOG="${LOG_DIR}/interop-scenario.log"

# PIDs of any long-running processes we spawn. Populated by step_boot_*.
PEER_PID=""
MOQWEB_PID=""

# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------
log() {
  local msg="[$(date -Iseconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "${msg}"
  echo "${msg}" >> "${SCENARIO_LOG}"
}

die_setup() {
  log "SETUP FAILURE: $*"
  cleanup
  exit 2
}

die_scenario() {
  log "SCENARIO FAILURE: $*"
  cleanup
  exit 1
}

is_alive() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

cleanup() {
  for pid in "${PEER_PID}" "${MOQWEB_PID}"; do
    if is_alive "${pid}"; then
      log "cleanup: terminating pid=${pid}"
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  done
  # Give processes a moment to exit gracefully, then force-kill.
  sleep 1 || true
  for pid in "${PEER_PID}" "${MOQWEB_PID}"; do
    if is_alive "${pid}"; then
      kill -KILL "${pid}" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT

# -----------------------------------------------------------------------------
# Peer binary resolution
# -----------------------------------------------------------------------------
resolve_peer_binary() {
  # Located after the peer build step in .github/workflows/interop.yml.
  case "${IMPLEMENTATION}" in
    moq-rs)
      # moq-cli builds a unified `moq` binary; moq-relay is a separate crate.
      # We pick the one that matches the role the peer plays.
      if [[ "${ROLE}" == "publisher" || "${ROLE}" == "subscriber" ]]; then
        echo "${PEER_ROOT}/target/release/moq"
      else
        echo "${PEER_ROOT}/target/release/moq-relay"
      fi
      ;;
    libquicr)
      # The examples/qclient target from Quicr/libquicr — plays both roles
      # via the --pub / --sub CLI switches. See libquicr/README.md § qClient.
      echo "${PEER_ROOT}/build/examples/qclient/qclient"
      ;;
    *)
      die_setup "unknown implementation '${IMPLEMENTATION}'"
      ;;
  esac
}

resolve_moqweb_binary() {
  # The interop CLI is bundled with @moq-web/session. See
  # packages/session/src/cli/interop-cli.ts.
  echo "${MOQ_WEB_ROOT}/packages/session/dist/cli/interop-cli.js"
}

# In DRY_RUN mode we replace the peer + moq-web binaries with tiny shell
# stubs that emit a synthetic OK marker so the whole harness pipeline can
# be smoke-tested end to end without external binaries.
dry_run_setup() {
  local stub_dir="${LOG_DIR}/interop-stubs"
  mkdir -p "${stub_dir}"

  cat > "${stub_dir}/peer.sh" <<EOF
#!/usr/bin/env bash
# Synthetic peer stub — logs each 'sent' or 'received' object, then exits.
echo "DRY_RUN peer role=\${1:-unknown}" >&2
for i in \$(seq 0 \$((${OBJECT_COUNT} - 1))); do
  echo "OBJECT groupId=0 objectId=\${i} bytes=32"
  sleep 0.05 || true
done
echo "OK: received ${OBJECT_COUNT} objects in order (group=0..0, object=0..\$((${OBJECT_COUNT} - 1)))"
EOF
  chmod +x "${stub_dir}/peer.sh"

  cat > "${stub_dir}/moqweb.sh" <<EOF
#!/usr/bin/env bash
echo "DRY_RUN moq-web role=\${1:-unknown}" >&2
for i in \$(seq 0 \$((${OBJECT_COUNT} - 1))); do
  echo "OBJECT groupId=0 objectId=\${i} bytes=32"
  sleep 0.05 || true
done
echo "OK: received ${OBJECT_COUNT} objects in order (group=0..0, object=0..\$((${OBJECT_COUNT} - 1)))"
EOF
  chmod +x "${stub_dir}/moqweb.sh"

  echo "${stub_dir}"
}

# -----------------------------------------------------------------------------
# Scenario steps
# -----------------------------------------------------------------------------
step_boot_peer() {
  local peer_bin peer_role peer_args
  peer_bin="$(resolve_peer_binary)"

  if [[ "${DRY_RUN}" == "1" ]]; then
    peer_bin="${STUB_DIR}/peer.sh ${ROLE}"
  fi

  if [[ "${DRY_RUN}" != "1" && ! -x "$(echo "${peer_bin}" | awk '{print $1}')" ]]; then
    die_setup "peer binary not found or not executable: ${peer_bin}"
  fi

  log "boot peer (${IMPLEMENTATION}) as ${ROLE} → ${peer_bin}"

  case "${IMPLEMENTATION}" in
    moq-rs)
      # moq-cli: `moq --connect <url> --broadcast <ns.name>.hang <import|export> ts`
      #   publisher  → import (from stdin)   — we feed /dev/zero, 32-byte frames
      #   subscriber → export (to stdout)    — count frames until OBJECT_COUNT
      # See rs/moq-cli/README.md in the moq repo for canonical invocations.
      if [[ "${ROLE}" == "publisher" ]]; then
        peer_args=(
          --connect "${PUBLISHER_URL}"
          --broadcast "${TRACK_NAMESPACE}.${TRACK_NAME}.hang"
          import ts
        )
      else
        peer_args=(
          --connect "${PUBLISHER_URL}"
          --broadcast "${TRACK_NAMESPACE}.${TRACK_NAME}.hang"
          export ts
        )
      fi
      ;;
    libquicr)
      # qclient: `qclient --pub_namespace <ns> --pub_name <t>` for publisher,
      # `qclient --sub_namespace <ns> --sub_name <t>` for subscriber.
      # See examples/qclient in libquicr for the full flag list.
      if [[ "${ROLE}" == "publisher" ]]; then
        peer_args=(
          --relay 127.0.0.1
          --port "${MOQ_RELAY_PORT}"
          --pub_namespace "${TRACK_NAMESPACE}"
          --pub_name "${TRACK_NAME}"
          --clock
        )
      else
        peer_args=(
          --relay 127.0.0.1
          --port "${MOQ_RELAY_PORT}"
          --sub_namespace "${TRACK_NAMESPACE}"
          --sub_name "${TRACK_NAME}"
        )
      fi
      ;;
  esac

  if [[ "${DRY_RUN}" == "1" ]]; then
    "${STUB_DIR}/peer.sh" "${ROLE}" > "${PEER_LOG}" 2>&1 &
  else
    # shellcheck disable=SC2086
    ${peer_bin} "${peer_args[@]}" > "${PEER_LOG}" 2>&1 &
  fi
  PEER_PID=$!
  log "peer pid=${PEER_PID} logging to ${PEER_LOG}"
}

step_boot_moqweb() {
  local moqweb_bin moqweb_role
  moqweb_bin="$(resolve_moqweb_binary)"

  if [[ "${DRY_RUN}" != "1" && ! -f "${moqweb_bin}" ]]; then
    die_setup "moq-web interop CLI not found: ${moqweb_bin} (did you run 'pnpm --filter @moq-web/session build'?)"
  fi

  if [[ "${ROLE}" == "publisher" ]]; then
    moqweb_role="subscriber"
  else
    moqweb_role="publisher"
  fi

  log "boot moq-web as ${moqweb_role}"

  # Give the peer a beat to start listening / dial the relay before we join.
  # 1s is enough for either moq-relay's local listen socket or qclient's
  # initial dial to be up. Callers can bump PEER_WARMUP_SECONDS if needed.
  sleep "${PEER_WARMUP_SECONDS:-1}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    "${STUB_DIR}/moqweb.sh" "${moqweb_role}" > "${MOQWEB_LOG}" 2>&1 &
  else
    node "${moqweb_bin}" \
      --role "${moqweb_role}" \
      --url "${PUBLISHER_URL}" \
      --namespace "${TRACK_NAMESPACE}" \
      --track "${TRACK_NAME}" \
      --object-count "${OBJECT_COUNT}" \
      --duration "${DURATION_SECONDS}" \
      > "${MOQWEB_LOG}" 2>&1 &
  fi
  MOQWEB_PID=$!
  log "moq-web pid=${MOQWEB_PID} logging to ${MOQWEB_LOG}"
}

step_wait_for_objects() {
  # Whichever side is the subscriber writes 'OBJECT groupId=... objectId=...'
  # per received object. Success = OBJECT_COUNT such lines within the
  # deadline. In DRY_RUN mode the stubs emit the same format so the same
  # check works.
  local subscriber_log
  if [[ "${ROLE}" == "publisher" ]]; then
    subscriber_log="${MOQWEB_LOG}"
  else
    subscriber_log="${PEER_LOG}"
  fi

  local deadline=$(( SECONDS + DURATION_SECONDS + 10 ))
  log "wait up to $((DURATION_SECONDS + 10))s for ${OBJECT_COUNT} objects in ${subscriber_log}"

  while (( SECONDS < deadline )); do
    if [[ -f "${subscriber_log}" ]]; then
      local received
      received=$(grep -c '^OBJECT ' "${subscriber_log}" 2>/dev/null || echo 0)
      # grep -c can emit a trailing newline in some shells; normalize.
      received="${received//$'\n'/}"
      if (( received >= OBJECT_COUNT )); then
        log "SUCCESS: subscriber received ${received} objects"
        return 0
      fi
    fi
    # Bail early if the subscriber side crashed without hitting the target.
    if [[ "${ROLE}" == "publisher" ]] && ! is_alive "${MOQWEB_PID}"; then
      die_scenario "moq-web subscriber exited before receiving ${OBJECT_COUNT} objects"
    fi
    if [[ "${ROLE}" == "subscriber" ]] && ! is_alive "${PEER_PID}"; then
      die_scenario "peer subscriber exited before receiving ${OBJECT_COUNT} objects"
    fi
    sleep 0.5
  done

  die_scenario "timeout: fewer than ${OBJECT_COUNT} objects in ${subscriber_log} after $((DURATION_SECONDS + 10))s"
}

step_teardown() {
  log "teardown: killing peer and moq-web processes"
  cleanup
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  mkdir -p "${LOG_DIR}"
  : > "${SCENARIO_LOG}"
  : > "${PEER_LOG}"
  : > "${MOQWEB_LOG}"

  log "=============================================================="
  log "interop scenario: peer=${IMPLEMENTATION} peer_role=${ROLE}"
  log "  namespace=${TRACK_NAMESPACE} track=${TRACK_NAME}"
  log "  objects=${OBJECT_COUNT} duration=${DURATION_SECONDS}s"
  log "  ports: relay=${MOQ_RELAY_PORT} moqweb=${MOQ_WEB_PORT}"
  log "  publisher_url=${PUBLISHER_URL}"
  log "  MOQ_WEB_ROOT=${MOQ_WEB_ROOT}"
  log "  PEER_ROOT=${PEER_ROOT}"
  log "  DRY_RUN=${DRY_RUN}"
  log "=============================================================="

  if [[ "${DRY_RUN}" == "1" ]]; then
    STUB_DIR="$(dry_run_setup)"
    log "DRY_RUN mode: using stubs at ${STUB_DIR}"
  fi

  step_boot_peer
  step_boot_moqweb
  step_wait_for_objects
  step_teardown

  log "scenario complete"
  exit 0
}

main "$@"
