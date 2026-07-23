#!/bin/zsh -f
set -euo pipefail
umask 077

readonly script_dir="${0:A:h}"
readonly native_root="${script_dir:h}"
readonly repository_root="${native_root:h:h:h}"
readonly overlay="${native_root}/swift-vfs-overlay.yaml"
readonly output_path="${1:-${repository_root}/dist/private-bin/assistant-gateway-peer-verifier}"
readonly output_dir="${output_path:h}"
readonly output_name="${output_path:t}"
readonly -a overlay_args=( -vfsoverlay "${overlay}" )
readonly build_mode="${2:-}"
typeset -a compiler_args=()
typeset -a source_args=()

if (( $# > 2 )); then
  exit 2
fi

case "${build_mode}" in
  "")
    source_args=( "${script_dir}/main.swift" "${script_dir}/PeerVerifier.swift" "${script_dir}/StrictJSON.swift" )
    ;;
  --testing)
    compiler_args=( -D ASSISTANT_TESTING )
    source_args=( "${script_dir}/main.swift" "${script_dir}/PeerVerifier.swift" "${script_dir}/StrictJSON.swift" )
    ;;
  --test-peer)
    compiler_args=( -D ASSISTANT_TESTING )
    source_args=( "${script_dir}/TestPeer.swift" )
    ;;
  --kernel-probe)
    compiler_args=( -D ASSISTANT_TESTING )
    source_args=( "${script_dir}/KernelProbe.swift" "${script_dir}/PeerVerifier.swift" "${script_dir}/StrictJSON.swift" )
    ;;
  *)
    exit 2
    ;;
esac

function verify_output_boundary() {
  local canonical_dir
  local directory_mode
  local directory_owner

  [[ "${output_path}" == /* ]] || return 1
  [[ -n "${output_name}" && "${output_name}" != "." && "${output_name}" != ".." ]] || return 1
  [[ "${output_path}" == "${output_dir}/${output_name}" ]] || return 1
  [[ "${output_dir:A}" == "${output_dir}" ]] || return 1
  [[ -d "${output_dir}" && ! -L "${output_dir}" ]] || return 1
  canonical_dir="$(/bin/realpath "${output_dir}")" || return 1
  [[ "${canonical_dir}" == "${output_dir}" ]] || return 1
  directory_mode="$(/usr/bin/stat -f '%Lp' "${output_dir}")" || return 1
  directory_owner="$(/usr/bin/stat -f '%u' "${output_dir}")" || return 1
  [[ "${directory_mode}" == "700" ]] || return 1
  [[ "${directory_owner}" == "$(/usr/bin/id -u)" ]] || return 1
  [[ ! -L "${output_path}" ]] || return 1
  if [[ -e "${output_path}" ]]; then
    [[ -f "${output_path}" ]] || return 1
    [[ "$(/usr/bin/stat -f '%u' "${output_path}")" == "$(/usr/bin/id -u)" ]] || return 1
    [[ "$(/usr/bin/stat -f '%Lp' "${output_path}")" == "500" ]] || return 1
  fi
}

[[ "${output_path}" == /* && "${output_dir:A}" == "${output_dir}" ]] || exit 2
/bin/mkdir -p "${output_dir}"
verify_output_boundary || exit 2

readonly temporary_root="$(/usr/bin/mktemp -d "${output_dir}/.${output_name}.build.XXXXXX")"
readonly compile_log="${temporary_root}/swiftc.stderr"
readonly staged_output="${temporary_root}/${output_name}"

function cleanup() {
  /bin/rm -f "${compile_log}" "${staged_output}"
  /bin/rmdir "${temporary_root}" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

LC_ALL=C LANG=C xcrun swiftc \
  "${overlay_args[@]}" \
  "${compiler_args[@]}" \
  "${source_args[@]}" \
  -framework Security \
  -lbsm \
  -o "${staged_output}" 2>"${compile_log}" || {
    /bin/cat "${compile_log}" >&2
    exit 1
  }
LC_ALL=C LANG=C /usr/bin/codesign --force --sign - --options runtime "${staged_output}"
/bin/chmod 0500 "${staged_output}"
LC_ALL=C LANG=C /usr/bin/codesign --verify --strict "${staged_output}"
[[ -f "${staged_output}" && ! -L "${staged_output}" ]] || exit 2
[[ "$(/usr/bin/stat -f '%u' "${staged_output}")" == "$(/usr/bin/id -u)" ]] || exit 2
[[ "$(/usr/bin/stat -f '%Lp' "${staged_output}")" == "500" ]] || exit 2
verify_output_boundary || exit 2
/bin/mv -f "${staged_output}" "${output_path}"
verify_output_boundary || exit 2
LC_ALL=C LANG=C /usr/bin/codesign --verify --strict "${output_path}"
