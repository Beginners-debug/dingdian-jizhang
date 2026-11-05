#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Compare A PK's assets/www/** against a source directory, file by file.

Usage:
    python verify_assets.py <apk> <web-dir>

Prints one line per file (OK / DIFF / MISSING / EXTRA) with sha256, then a summary.
Exit code 0 only when every file matches and the two sets are identical.
"""

import hashlib
import io
import os
import sys
import zipfile

PREFIX = "assets/www/"


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def source_files(root):
    """Relative POSIX paths of every regular file under root (skip .tmp / node_modules)."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in (".tmp", "node_modules"))
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out[rel] = full
    return out


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: verify_assets.py <apk> <web-dir>\n")
        return 2
    apk_path, web_root = argv[1], argv[2]

    pack = {}
    with zipfile.ZipFile(apk_path) as zf:
        for info in zf.infolist():
            name = info.filename
            if name.startswith(PREFIX) and not name.endswith("/"):
                pack[name[len(PREFIX):]] = sha256_bytes(zf.read(name))

    src = source_files(web_root)
    src_hashes = {}
    for rel, full in src.items():
        with io.open(full, "rb") as fh:
            src_hashes[rel] = sha256_bytes(fh.read())

    ok = diff = missing = extra = 0
    width = max([len(k) for k in list(src_hashes) + list(pack)] or [10])
    for rel in sorted(src_hashes):
        want = src_hashes[rel]
        if rel not in pack:
            missing += 1
            print("MISSING  %-*s  in web/ but not in apk  %s" % (width, rel, want))
        elif pack[rel] != want:
            diff += 1
            print("DIFF     %-*s  apk=%s  web=%s" % (width, rel, pack[rel], want))
        else:
            ok += 1
            print("OK       %-*s  %s" % (width, rel, want))
    for rel in sorted(pack):
        if rel not in src_hashes:
            extra += 1
            print("EXTRA    %-*s  in apk but not in web/  %s" % (width, rel, pack[rel]))

    print("")
    print("summary: %d OK / %d DIFF / %d MISSING / %d EXTRA  (apk=%d files, web=%d files)"
          % (ok, diff, missing, extra, len(pack), len(src_hashes)))
    return 0 if (diff == 0 and missing == 0 and extra == 0) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
