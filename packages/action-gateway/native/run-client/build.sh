#!/bin/zsh -f
set -euo pipefail
umask 077

readonly script_dir="${0:A:h}"
readonly native_root="${script_dir:h}"
readonly repository_root="${native_root:h:h:h}"
readonly output_path="${1:-${repository_root}/dist/public-bin/assistant-gateway}"
readonly output_dir="${output_path:h}"
readonly output_name="${output_path:t}"
readonly duplicate_module_map='/Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap'
readonly primary_module_map='/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap'

if (( $# > 1 )); then
  exit 2
fi

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
    [[ "$(/usr/bin/stat -f '%Lp' "${output_path}")" == "555" ]] || return 1
  fi
}

if [[ "${output_path}" != /* ]] || [[ "${output_dir:A}" != "${output_dir}" ]]; then
  /usr/bin/printf '%s\n' 'invalid run-client output path' >&2
  exit 2
fi

/bin/mkdir -p "${output_dir}"
if ! verify_output_boundary; then
  /usr/bin/printf '%s\n' 'run-client output parent is not a directory' >&2
  exit 2
fi

readonly temporary_root="$(/usr/bin/mktemp -d "${output_dir}/.${output_name}.build.XXXXXX")"
readonly overlay="${temporary_root}/swift-vfs-overlay.yaml"
readonly compile_log="${temporary_root}/swiftc.stderr"
readonly staged_output="${temporary_root}/${output_name}"

function cleanup() {
  /bin/rm -f "${overlay}" "${compile_log}" "${staged_output}"
  /bin/rmdir "${temporary_root}" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

if [[ -f "${duplicate_module_map}" ]] && \
   [[ -f "${primary_module_map}" ]] && \
   /usr/bin/grep -Fq 'module SwiftBridging' "${duplicate_module_map}" && \
   /usr/bin/grep -Fq 'module SwiftBridging' "${primary_module_map}"; then
  /usr/bin/printf '%s\n' \
    '{' \
    '  "version": 0,' \
    '  "case-sensitive": "true",' \
    '  "roots": [' \
    '    {' \
    '      "type": "file",' \
    '      "name": "/Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap",' \
    '      "external-contents": "/dev/null"' \
    '    }' \
    '  ]' \
    '}' >"${overlay}"
  readonly -a overlay_args=( -vfsoverlay "${overlay}" )
else
  readonly -a overlay_args=()
fi

LC_ALL=C LANG=C xcrun swiftc "${overlay_args[@]}" \
  "${script_dir}/main.swift" \
  "${script_dir}/Framing.swift" \
  -o "${staged_output}" 2>"${compile_log}" || {
    /bin/cat "${compile_log}" >&2
    exit 1
  }

LC_ALL=C LANG=C /usr/bin/codesign --force --sign - --options runtime "${staged_output}"
LC_ALL=C LANG=C /usr/bin/codesign --verify --strict "${staged_output}"
/bin/chmod 0555 "${staged_output}"
LC_ALL=C LANG=C /usr/bin/codesign --verify --strict "${staged_output}"
[[ -f "${staged_output}" && ! -L "${staged_output}" ]] || exit 2
[[ "$(/usr/bin/stat -f '%u' "${staged_output}")" == "$(/usr/bin/id -u)" ]] || exit 2
[[ "$(/usr/bin/stat -f '%Lp' "${staged_output}")" == "555" ]] || exit 2
verify_output_boundary || exit 2
/bin/mv -f "${staged_output}" "${output_path}"
verify_output_boundary || exit 2
LC_ALL=C LANG=C /usr/bin/codesign --verify --strict "${output_path}"
