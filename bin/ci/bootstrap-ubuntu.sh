#!/usr/bin/env bash
# Optional Ubuntu bootstrap; no phone, signing, relay or Cloudflare API credentials needed.
set -euo pipefail
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
[[ $(uname -s) == Linux ]] || { echo 'Linux is required.' >&2; exit 2; }
command -v node >/dev/null && node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || {
  echo 'Configure the build image with Node.js 24 or newer before bootstrap.' >&2; exit 2;
}
task_tools=$(mktemp -d "${TMPDIR:-/tmp}/poki-ci-tools.XXXXXXXX")
task_missing=()
for task_tool in git curl python3 pkg-config cc c++ make ar cmake tar gzip sha256sum; do
  command -v "$task_tool" >/dev/null || task_missing+=("$task_tool")
done
pkg-config --exists dbus-1 2>/dev/null || task_missing+=(libdbus-1-dev)
if [[ ${#task_missing[@]} != 0 ]]; then
  printf 'Missing build prerequisites: %s\n' "${task_missing[*]}" >&2
  [[ ${POKI_CI_INSTALL_PACKAGES:-0} == 1 ]] || {
    echo 'Preinstall them, or set POKI_CI_INSTALL_PACKAGES=1. Default features are preserved.' >&2
    exit 2
  }
  if [[ $(id -u) == 0 ]]; then
    task_sudo=()
  elif command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1; then
    task_sudo=(sudo -n)
  else
    # Pages has no passwordless sudo. Only these bounded dependencies can be
    # supplied in a private prefix; a missing compiler or base tool still fails.
    for task_tool in "${task_missing[@]}"; do
      case "$task_tool" in pkg-config|libdbus-1-dev|cmake) ;;
        *) echo "Cannot bootstrap missing base tool without root: $task_tool" >&2; exit 2 ;;
      esac
    done
    source "$task_root/bin/ci/ubuntu-userspace.sh"
    if ! command -v pkg-config >/dev/null || ! pkg-config --exists dbus-1; then
      poki_ci_userspace_dbus "$task_tools"
    fi
    if ! command -v cmake >/dev/null; then
      poki_ci_userspace_cmake "$task_tools"
    fi
    task_sudo=(userspace-complete)
  fi
  if [[ ${task_sudo[0]:-} != userspace-complete ]]; then
    "${task_sudo[@]}" apt-get update
    "${task_sudo[@]}" apt-get install -y --no-install-recommends git curl ca-certificates python3 pkg-config build-essential cmake libdbus-1-dev tar gzip coreutils
  fi
fi
# Check the actual usable compiler/header/link/runtime combination before Cargo.
python3 -I -B - "$task_tools" <<'PY'
import pathlib,shlex,subprocess,sys
root=pathlib.Path(sys.argv[1]); source=root/'dbus-probe.c'; binary=root/'dbus-probe'
source.write_text('#include <dbus/dbus.h>\nint main(void) { int a,b,c; dbus_get_version(&a,&b,&c); return a < 1; }\n')
flags=shlex.split(subprocess.check_output(['pkg-config','--cflags','--libs','dbus-1'],text=True))
subprocess.run(['cc',str(source),'-o',str(binary),*flags],check=True)
subprocess.run([str(binary)],check=True)
PY
case $(uname -m) in
  x86_64) task_rust_target=x86_64-unknown-linux-gnu; task_action_arch=amd64 ;;
  aarch64|arm64) task_rust_target=aarch64-unknown-linux-gnu; task_action_arch=arm64 ;;
  *) echo 'Unsupported bootstrap architecture; no checks were skipped.' >&2; exit 2 ;;
esac
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
if ! command -v rustup >/dev/null; then
  task_rustup_url="https://static.rust-lang.org/rustup/archive/1.29.3/$task_rust_target/rustup-init"
  curl --proto '=https' --tlsv1.2 -sSfL "$task_rustup_url" -o "$task_tools/rustup-init"
  curl --proto '=https' --tlsv1.2 -sSfL "$task_rustup_url.sha256" -o "$task_tools/rustup-init.sha256"
  task_rustup_sha=$(python3 -I -c 'import pathlib,re,sys; s=pathlib.Path(sys.argv[1]).read_text().split()[0]; assert re.fullmatch(r"[a-fA-F0-9]{64}",s); print(s)' "$task_tools/rustup-init.sha256")
  (cd "$task_tools" && printf '%s  rustup-init\n' "$task_rustup_sha" | sha256sum --check -)
  chmod 700 "$task_tools/rustup-init"
  "$task_tools/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
fi
rustup toolchain install 1.99.1 --profile minimal --no-self-update
if ! command -v actionlint >/dev/null || [[ ! $(actionlint --version | head -1) =~ ^v?1\.7\.7$ ]]; then
  # Discover the official checksum asset rather than execute a downloader before verification.
  task_action_file="actionlint_1.7.7_linux_$task_action_arch.tar.gz"
  curl --proto '=https' --tlsv1.2 -sSfL https://api.github.com/repos/rhysd/actionlint/releases/tags/v1.7.7 -o "$task_tools/actionlint-release.json"
  python3 -I - "$task_tools/actionlint-release.json" "$task_action_file" > "$task_tools/actionlint-urls.txt" <<'PY'
import json,sys
v=json.load(open(sys.argv[1])); assert v['tag_name']=='v1.7.7'
assets=v['assets']; archive=[a for a in assets if a['name']==sys.argv[2]]
checks=[a for a in assets if 'checksums' in a['name'].lower() and a['name'].endswith('.txt')]
assert len(archive)==len(checks)==1
for a in (archive[0],checks[0]):
    u=a['browser_download_url']; assert u.startswith('https://github.com/rhysd/actionlint/releases/download/v1.7.7/'); print(u)
PY
  task_action_url=$(sed -n '1p' "$task_tools/actionlint-urls.txt")
  task_checks_url=$(sed -n '2p' "$task_tools/actionlint-urls.txt")
  curl --proto '=https' --tlsv1.2 -sSfL "$task_action_url" -o "$task_tools/$task_action_file"
  curl --proto '=https' --tlsv1.2 -sSfL "$task_checks_url" -o "$task_tools/actionlint-checksums.txt"
  task_action_sha=$(python3 -I - "$task_tools/actionlint-checksums.txt" "$task_action_file" <<'PY'
import pathlib,re,sys
rows=[line.split() for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
matches=[p[0] for p in rows if len(p)==2 and p[1].lstrip('*')==sys.argv[2] and re.fullmatch(r'[a-fA-F0-9]{64}',p[0])]
assert len(matches)==1; print(matches[0])
PY
  )
  (cd "$task_tools" && printf '%s  %s\n' "$task_action_sha" "$task_action_file" | sha256sum --check -)
  tar -xzf "$task_tools/$task_action_file" -C "$task_tools" actionlint
  export PATH="$task_tools:$PATH"
fi
cd "$task_root"
exec node bin/ci/linux.mjs "$@"
