#!/usr/bin/env python3
"""Bind a controlled native build to source snapshots and a candidate binary.

prepare records the native bridge, its local idevice dependency, and build inputs.
Build with the emitted POKI_BUILD_ID, then finish before installing the candidate.
finish rejects source drift and a mismatched embedded ID, and records binary SHA.
This is a source/binary receipt, not a claim of a hermetic or reproducible build.
The only executable invoked here is the explicit candidate with --build-info.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


SCHEMA = 1
TREES = ("native/bridge", ".deps/idevice")
EXCLUDED = {".git", "target", "__pycache__", ".DS_Store"}
REQUIRED = (
    "native/bridge/Cargo.toml", "native/bridge/Cargo.lock",
    "native/bridge/src/main.rs", ".deps/idevice/Cargo.toml",
    ".deps/idevice/idevice/Cargo.toml", "bin/build-native",
    "bin/native-build-receipt.py",
)
OPTIONAL = (
    "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml",
    ".cargo/config", ".cargo/config.toml", "native/.cargo/config",
    "native/.cargo/config.toml", "native/ocr.swift", "native/simulator.m",
)
SCOPE = {"trees": list(TREES), "required": list(REQUIRED),
         "optional": list(OPTIONAL), "excluded_names": sorted(EXCLUDED),
         "file_symlinks": "regular_file_within_declared_tree"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(files):
    value = {"schema_version": SCHEMA, "scope": SCOPE, "files": files}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"))
                          .encode("utf-8")).hexdigest()


def within(path, directory):
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


def source_snapshot(root):
    root = root.resolve(strict=True)
    files = {}

    def add(path, name, boundary, logical_boundary):
        source = path
        link = None
        if path.is_symlink():
            link = os.readlink(path)
            try:
                source = path.resolve(strict=True)
            except (OSError, RuntimeError) as error:
                raise ValueError("source file symlink is dangling or cyclic: " + name) from error
            if not within(source, boundary):
                raise ValueError("source file symlink escapes declared source tree: " + name)
        attributes = source.stat()
        if not stat.S_ISREG(attributes.st_mode):
            raise ValueError("source input is not a regular file: " + name)
        record = {"path": name, "bytes": attributes.st_size,
                  "mode": stat.S_IMODE(attributes.st_mode),
                  "sha256": digest_file(source)}
        if link is not None:
            if os.readlink(path) != link:
                raise ValueError("source file symlink changed during snapshot: " + name)
            record["symlink_target"] = link
            record["resolved_path"] = str(Path(logical_boundary) / source.relative_to(boundary))
        files[name] = record

    for name in REQUIRED:
        if not (root / name).is_file():
            raise ValueError("required source input missing: " + name)
    for prefix in TREES:
        # The explicitly declared dependency root may be a shared symlink.
        tree = (root / prefix).resolve(strict=True)
        if not tree.is_dir():
            raise ValueError("source tree is not a directory: " + prefix)
        for directory, dirs, names in os.walk(tree, followlinks=False):
            directory = Path(directory)
            dirs[:] = sorted(name for name in dirs if name not in EXCLUDED)
            for name in dirs:
                if (directory / name).is_symlink():
                    raise ValueError("nested source directory symlink must be reviewed: " +
                                     str(Path(prefix) / (directory / name).relative_to(tree)))
            for name in sorted(names):
                if name not in EXCLUDED:
                    path = directory / name
                    add(path, str(Path(prefix) / path.relative_to(tree)), tree, prefix)
    for name in REQUIRED + OPTIONAL:
        if name not in files and (root / name).exists():
            add(root / name, name, root, "")
    ordered = [files[name] for name in sorted(files)]
    digest = fingerprint(ordered)
    return {"schema_version": SCHEMA, "kind": "poki-native-source",
            "root": str(root), "scope": SCOPE, "files": ordered,
            "source_fingerprint": digest, "build_id": "native-proof-v1-" + digest}


def outside_inputs(root, output):
    destination = output.resolve()
    for tree in TREES:
        if within(destination, (root / tree).resolve()):
            raise ValueError("receipt output must be outside source trees")
    if destination in {(root / name).resolve() for name in REQUIRED + OPTIONAL}:
        raise ValueError("receipt output would overwrite a source input")


def write_exclusive(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write("\n")


def prepare(root, output):
    outside_inputs(root, output)
    snapshot = source_snapshot(root)
    snapshot["prepared_utc"] = now()
    write_exclusive(output, snapshot)
    return {"prepared": str(output.resolve()), "build_id": snapshot["build_id"],
            "source_fingerprint": snapshot["source_fingerprint"]}


def inspect_binary(binary):
    result = subprocess.run([str(binary), "--build-info"], check=True,
                            capture_output=True, text=True, timeout=10)
    info = json.loads(result.stdout)
    runtime = info.get("native_runtime", {}) if isinstance(info, dict) else {}
    features = runtime.get("features", []) if isinstance(runtime, dict) else []
    if (not isinstance(runtime, dict) or not isinstance(features, list) or
            "native_execution_v1" not in features):
        raise ValueError("candidate lacks native_execution_v1 build information")
    return runtime


def finish(root, prepared, binary, output):
    root = root.resolve(strict=True)
    binary = binary.resolve(strict=True)
    outside_inputs(root, output)
    if output.resolve() in {binary, prepared.resolve()}:
        raise ValueError("receipt output must not replace the prepared manifest or binary")
    expected = json.loads(prepared.read_text(encoding="utf-8"))
    if (expected.get("schema_version") != SCHEMA or
            expected.get("kind") != "poki-native-source" or
            expected.get("root") != str(root) or expected.get("scope") != SCOPE or
            fingerprint(expected["files"]) != expected.get("source_fingerprint") or
            expected.get("build_id") != "native-proof-v1-" + expected["source_fingerprint"]):
        raise ValueError("prepared manifest is inconsistent with this source snapshot format")
    before = digest_file(binary)
    runtime = inspect_binary(binary)
    if runtime.get("build_id") != expected["build_id"]:
        raise ValueError("candidate POKI_BUILD_ID does not match the prepared source fingerprint")
    actual = source_snapshot(root)
    if actual["source_fingerprint"] != expected["source_fingerprint"]:
        raise ValueError("native source inputs changed during the build; prepare and build again")
    if digest_file(binary) != before:
        raise ValueError("candidate binary changed during verification")
    receipt = {"schema_version": SCHEMA, "kind": "poki-native-build",
               "verified_utc": now(), "build_id": expected["build_id"],
               "source_fingerprint": expected["source_fingerprint"],
               "prepared_manifest": expected, "native_runtime": runtime,
               "binary": {"path": str(binary), "bytes": binary.stat().st_size,
                          "sha256": before}}
    write_exclusive(output, receipt)
    return {"receipt": str(output.resolve()), "build_id": expected["build_id"],
            "binary_sha256": before, "source_fingerprint": expected["source_fingerprint"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("prepare", "finish"):
        arguments = commands.add_parser(command)
        arguments.add_argument("--root", type=Path, required=True)
        arguments.add_argument("--output", type=Path, required=True)
        if command == "finish":
            arguments.add_argument("--prepared", type=Path, required=True)
            arguments.add_argument("--binary", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        if arguments.command == "prepare":
            result = prepare(arguments.root, arguments.output)
        else:
            result = finish(arguments.root, arguments.prepared, arguments.binary, arguments.output)
        print(json.dumps(result, sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
