#!/usr/bin/env bash
# Sourced by bootstrap-ubuntu.sh. No installed files or package database are changed.

poki_ci_userspace_dbus() {
  local task_base="$1/ubuntu-deps" task_arch task_triplet task_archive task_security task_tool
  local task_os task_deb task_name task_version task_deb_arch task_dbus_version='' task_dev_version=''
  for task_tool in apt-get dpkg dpkg-deb gpgv; do
    command -v "$task_tool" >/dev/null || { echo "Userspace DBus bootstrap requires: $task_tool" >&2; return 2; }
  done
  task_os=$(python3 -I -B -c 'import pathlib,shlex; d=dict(line.split("=",1) for line in pathlib.Path("/etc/os-release").read_text().splitlines() if "=" in line and not line.startswith("#")); print(shlex.split(d.get("ID",""))[0]+":"+shlex.split(d.get("VERSION_CODENAME",""))[0])')
  [[ $task_os == ubuntu:jammy ]] || { echo "Userspace DBus bootstrap requires Ubuntu Jammy; observed $task_os" >&2; return 2; }
  [[ -s /usr/share/keyrings/ubuntu-archive-keyring.gpg ]] || { echo 'Missing Ubuntu archive signing keyring.' >&2; return 2; }
  task_arch=$(dpkg --print-architecture)
  case "$task_arch" in
    amd64) task_triplet=x86_64-linux-gnu; task_archive=https://archive.ubuntu.com/ubuntu; task_security=https://security.ubuntu.com/ubuntu ;;
    arm64) task_triplet=aarch64-linux-gnu; task_archive=https://ports.ubuntu.com/ubuntu-ports; task_security=$task_archive ;;
    *) echo "Unsupported Ubuntu architecture: $task_arch" >&2; return 2 ;;
  esac
  [[ ! -e $task_base ]] || { echo 'Userspace dependency prefix must be fresh.' >&2; return 2; }
  mkdir -m 700 "$task_base"
  mkdir -p "$task_base/empty" "$task_base/lists/partial" "$task_base/cache/archives/partial" "$task_base/log" "$task_base/downloads" "$task_base/root"
  : > "$task_base/status"
  cat > "$task_base/sources.list" <<EOF
deb [arch=$task_arch signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $task_archive jammy main
deb [arch=$task_arch signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $task_archive jammy-updates main
deb [arch=$task_arch signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $task_security jammy-security main
EOF
  # APT_CONFIG is read before host fragments. Exclude host hooks, stale lists,
  # third-party repositories and trust overrides; leave signature/hash checks on.
  cat > "$task_base/apt.conf" <<EOF
Dir::Etc::main "/dev/null";
Dir::Etc::parts "$task_base/empty";
Dir::Etc::sourcelist "$task_base/sources.list";
Dir::Etc::sourceparts "$task_base/empty";
Dir::Etc::preferences "/dev/null";
Dir::Etc::preferencesparts "$task_base/empty";
Dir::State "$task_base";
Dir::State::status "$task_base/status";
Dir::State::lists "$task_base/lists";
Dir::Cache "$task_base/cache";
Dir::Cache::archives "$task_base/cache/archives";
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
Dir::Log "$task_base/log";
APT::Architecture "$task_arch";
APT::Update::Error-Mode "any";
Acquire::Languages "none";
Acquire::Retries "2";
Acquire::https::Timeout "30";
Acquire::Check-Valid-Until "true";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
APT::Get::AllowUnauthenticated "false";
EOF
  APT_CONFIG="$task_base/apt.conf" apt-get update
  local task_packages=("libdbus-1-dev:$task_arch" "libdbus-1-3:$task_arch")
  if ! command -v pkg-config >/dev/null; then task_packages+=("pkg-config:$task_arch"); fi
  (cd "$task_base/downloads" && APT_CONFIG="$task_base/apt.conf" apt-get download "${task_packages[@]}")
  local task_count=0
  for task_deb in "$task_base/downloads/"*.deb; do
    [[ -f $task_deb ]] || { echo 'APT did not download the required packages.' >&2; return 2; }
    task_name=$(dpkg-deb -f "$task_deb" Package)
    task_version=$(dpkg-deb -f "$task_deb" Version)
    task_deb_arch=$(dpkg-deb -f "$task_deb" Architecture)
    [[ $task_deb_arch == "$task_arch" ]] || { echo 'Downloaded package architecture mismatch.' >&2; return 2; }
    case "$task_name" in
      libdbus-1-dev) [[ -z $task_dev_version ]] || return 2; task_dev_version=$task_version ;;
      libdbus-1-3) [[ -z $task_dbus_version ]] || return 2; task_dbus_version=$task_version ;;
      pkg-config) ;;
      *) echo 'Unexpected package in userspace dependency download.' >&2; return 2 ;;
    esac
    printf 'CI_DEPENDENCY %s %s %s\n' "$task_name" "$task_version" "$task_deb_arch"
    sha256sum "$task_deb"
    dpkg-deb --extract "$task_deb" "$task_base/root"
    task_count=$((task_count+1))
  done
  [[ $task_count == ${#task_packages[@]} && -n $task_dev_version && $task_dev_version == "$task_dbus_version" ]] || {
    echo 'Incomplete or mismatched DBus package pair.' >&2; return 2;
  }
  # Relocate only these downloaded files. A global pkg-config sysroot would
  # incorrectly redirect unrelated installed libraries such as OpenSSL.
  python3 -I -B "$task_root/bin/ci/relocate-dbus.py" "$task_base/root" "$task_triplet"
  export PATH="$task_base/root/usr/bin:$PATH"
  export PKG_CONFIG_PATH="$task_base/root/usr/lib/$task_triplet/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export LIBRARY_PATH="$task_base/root/usr/lib/$task_triplet:$task_base/root/lib/$task_triplet${LIBRARY_PATH:+:$LIBRARY_PATH}"
  export LD_LIBRARY_PATH="$task_base/root/usr/lib/$task_triplet:$task_base/root/lib/$task_triplet${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  pkg-config --modversion dbus-1
}

poki_ci_userspace_cmake() {
  local task_tools="$1" task_name=cmake-3.31.6-linux-x86_64 task_sha=5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf
  [[ $(uname -m) == x86_64 ]] || { echo 'The pinned userspace CMake bootstrap currently supports x86_64 only.' >&2; return 2; }
  curl --proto '=https' --tlsv1.2 -sSfL "https://github.com/Kitware/CMake/releases/download/v3.31.6/$task_name.tar.gz" -o "$task_tools/$task_name.tar.gz"
  (cd "$task_tools" && printf '%s  %s.tar.gz\n' "$task_sha" "$task_name" | sha256sum --check -)
  tar -xzf "$task_tools/$task_name.tar.gz" -C "$task_tools" --no-same-owner
  export PATH="$task_tools/$task_name/bin:$PATH"
  [[ $(cmake --version | head -1) == 'cmake version 3.31.6' ]] || { echo 'CMake bootstrap version mismatch.' >&2; return 2; }
}
