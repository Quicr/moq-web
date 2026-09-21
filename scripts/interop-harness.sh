#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
# SPDX-License-Identifier: BSD-2-Clause
#
# interop-harness.sh — canned scenario runner for the MoQ interop matrix.
#
# STATUS: skeleton. This script documents the intended contract and step
# sequence but does not yet spawn peer binaries or moq-web. See
# .github/workflows/README.md § "Enabling interop" for the follow-up work.
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
#                      "https://127.0.0.1:4443/moq". The harness picks the URL
#                      based on which side hosts.
#   RELAY_URL          When both sides act as clients, the URL of a relay.
#   LOG_DIR            Directory to write logs (default: /tmp).
#
# Exit codes:
#
#   0    success — subscriber received exactly OBJECT_COUNT objects in
#        ascending group/object order within DURATION_SECONDS + slack.
#   1    scenario failed (missed objects, out-of-order delivery, or timeout).
#   2    setup failed (peer or moq-web binary missing, or bad env vars).
#   3    NOT_IMPLEMENTED — the current skeleton always returns this until the
#        harness is filled in.
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
PUBLISHER_URL="${PUBLISHER_URL:-https://127.0.0.1:4443/moq}"
LOG_DIR="${LOG_DIR:-/tmp}"

PEER_LOG="${LOG_DIR}/interop-peer.log"
MOQWEB_LOG="${LOG_DIR}/interop-moqweb.log"
SCENARIO_LOG="${LOG_DIR}/interop-scenario.log"

# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------
log() {
  # Timestamped scenario log line; also mirrored to stdout for CI visibility.
  local msg="[$(date -Iseconds)] $*"
  echo "${msg}"
  echo "${msg}" >> "${SCENARIO_LOG}"
}

die_setup() {
  log "SETUP FAILURE: $*"
  exit 2
}

die_scenario() {
  log "SCENARIO FAILURE: $*"
  exit 1
}

not_implemented() {
  log "NOT_IMPLEMENTED: $*"
  log "See .github/workflows/README.md § 'Enabling interop' for the follow-up work."
  exit 3
}

# -----------------------------------------------------------------------------
# Peer binary resolution
# -----------------------------------------------------------------------------
resolve_peer_binary() {
  # Locate the peer's publisher/subscriber CLI entry point. Populated during
  # the follow-up (see README § step 1).
  case "${IMPLEMENTATION}" in
    moq-rs)
      # e.g. "${PEER_ROOT}/target/release/moq-relay" or "moq-clock"; depends on
      # which mode we're driving.
      echo "${PEER_ROOT}/target/release/moq-clock"
      ;;
    libquicr)
      # e.g. "${PEER_ROOT}/build/samples/qclient" or similar.
      echo "${PEER_ROOT}/build/samples/qclient"
      ;;
    *)
      die_setup "unknown implementation '${IMPLEMENTATION}'"
      ;;
  esac
}

resolve_moqweb_binary() {
  # moq-web needs a headless CLI entry point that speaks pub/sub. Not shipped
  # today — the follow-up will land it at apps/interop-cli or similar.
  echo "${MOQ_WEB_ROOT}/apps/interop-cli/dist/interop-cli.js"
}

# -----------------------------------------------------------------------------
# Scenario steps (skeleton)
# -----------------------------------------------------------------------------
step_boot_peer() {
  local peer_bin
  peer_bin="$(resolve_peer_binary)"
  if [[ ! -x "${peer_bin}" ]]; then
    die_setup "peer binary not found or not executable: ${peer_bin}"
  fi

  log "boot peer (${IMPLEMENTATION}) as ${ROLE}"
  # TODO: spawn peer binary with the appropriate args for its role,
  #       redirecting stdout/stderr to ${PEER_LOG}.
}

step_boot_moqweb() {
  local moqweb_bin moqweb_role
  moqweb_bin="$(resolve_moqweb_binary)"
  if [[ ! -f "${moqweb_bin}" ]]; then
    die_setup "moq-web interop CLI not found: ${moqweb_bin}"
  fi

  if [[ "${ROLE}" == "publisher" ]]; then
    moqweb_role="subscriber"
  else
    moqweb_role="publisher"
  fi

  log "boot moq-web as ${moqweb_role}"
  # TODO: node ${moqweb_bin} --role ${moqweb_role} \
  #         --url ${PUBLISHER_URL} \
  #         --namespace ${TRACK_NAMESPACE} \
  #         --track ${TRACK_NAME} \
  #         --count ${OBJECT_COUNT} \
  #         --duration ${DURATION_SECONDS} \
  #         > ${MOQWEB_LOG} 2>&1 &
}

step_wait_for_objects() {
  # Success condition: subscriber writes a line like:
  #   "OK: received 10 objects in order (group=0..0, object=0..9)"
  # to ${MOQWEB_LOG} or ${PEER_LOG} (whichever side is subscribing).
  log "wait up to ${DURATION_SECONDS}s + 5s for ${OBJECT_COUNT} objects"
  # TODO: poll the appropriate log file; grep for the success marker.
}

step_teardown() {
  log "teardown: killing peer and moq-web processes"
  # TODO: kill spawned PIDs; wait; flush logs.
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  mkdir -p "${LOG_DIR}"
  : > "${SCENARIO_LOG}"

  log "=============================================================="
  log "interop scenario: peer=${IMPLEMENTATION} peer_role=${ROLE}"
  log "  namespace=${TRACK_NAMESPACE} track=${TRACK_NAME}"
  log "  objects=${OBJECT_COUNT} duration=${DURATION_SECONDS}s"
  log "  MOQ_WEB_ROOT=${MOQ_WEB_ROOT}"
  log "  PEER_ROOT=${PEER_ROOT}"
  log "=============================================================="

  # Skeleton: run the scaffolding to prove env-vars parse, then bail. Fill
  # these in to make the workflow useful (see README § "Enabling interop").
  step_boot_peer
  step_boot_moqweb
  step_wait_for_objects
  step_teardown

  not_implemented "scenario harness not yet implemented"
}

main "$@"
