#!/usr/bin/env python3
"""Relocate an extracted DBus SDK without redirecting system pkg-config modules."""
import os
import pathlib
import re
import sys


def relocate(root, triplet):
    root = pathlib.Path(root).resolve(strict=True)
    if triplet not in ("x86_64-linux-gnu", "aarch64-linux-gnu"):
        raise ValueError("unsupported architecture")
    pc = root / "usr" / "lib" / triplet / "pkgconfig" / "dbus-1.pc"
    text = pc.read_text()
    for name in ("original_prefix", "prefix", "exec_prefix", "libdir", "includedir"):
        text = re.sub(r"(?m)^" + name + r"=(/[^\n]*)$",
                      lambda m: name + "=" + str(root) + m[1], text)
    pc.write_text(text)
    # Debian may encode /usr/lib -> /lib links as absolute. Keep them in the
    # private extraction instead of accidentally selecting the host version.
    for directory, _, files in os.walk(root, followlinks=False):
        for filename in files:
            path = pathlib.Path(directory) / filename
            if path.is_symlink():
                target = os.readlink(path)
                if target.startswith("/"):
                    local = root / target.lstrip("/")
                    if not local.is_file():
                        raise ValueError("absolute package link has no private target")
                    path.unlink()
                    path.symlink_to(os.path.relpath(local, path.parent))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: relocate-dbus.py ROOT TRIPLET")
    relocate(sys.argv[1], sys.argv[2])
