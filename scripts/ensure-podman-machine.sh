#!/usr/bin/env bash
set -euo pipefail

machine="${AGENTGRANNY_PODMAN_MACHINE:-agentgranny2}"
cpus="${AGENTGRANNY_PODMAN_MACHINE_CPUS:-4}"
memory="${AGENTGRANNY_PODMAN_MACHINE_MEMORY:-4096}"
disk="${AGENTGRANNY_PODMAN_MACHINE_DISK:-40}"
podman_bin="${AGENTGRANNY_PODMAN_BIN:-podman}"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if command -v getconf >/dev/null 2>&1; then
    export TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"
  fi
fi

if ! command -v "${podman_bin}" >/dev/null 2>&1; then
  echo "podman not found; enter the nix dev shell or run through just" >&2
  exit 1
fi

podman_cmd() {
  "${podman_bin}" "$@"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  podman_cmd info >/dev/null
  echo "podman ready"
  exit 0
fi

if ! podman_cmd machine inspect "${machine}" >/dev/null 2>&1; then
  echo "Creating Podman machine ${machine}" >&2
  podman_cmd machine init \
    --cpus "${cpus}" \
    --memory "${memory}" \
    --disk-size "${disk}" \
    "${machine}"
fi

state="$(podman_cmd machine inspect --format '{{.State}}' "${machine}" 2>/dev/null || true)"
if [[ "${state}" != "running" ]]; then
  echo "Starting Podman machine ${machine}" >&2
  podman_cmd machine start "${machine}"
fi

podman_cmd --connection "${machine}" info >/dev/null
echo "podman ready: ${machine}"
