#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Repack an APK produced by `aapt2 link`: normalise zip headers, add classes.dex.

Usage: python inject_dex.py <in.apk> <classes.dex> <out.apk>

aapt2 link knows nothing about java bytecode and d8 knows nothing about APK packaging,
so the two halves get stitched together at the zip level.

Why repack instead of `ZipFile(..., "a")`:
  * aapt2 on Windows writes the *local* header names of assets with backslashes
    (`assets/www\app.js`) while the central directory uses forward slashes. Android's
    libziparchive reads the central directory so it works, but any tool that validates
    local headers (python's testzip, most unzippers) calls the archive corrupt.
  * rebuilding gives one consistent archive and lets us drop duplicate names.

Entries keep their original compression method - resources.arsc in particular must stay
STORED (Android mmaps it) and zipalign runs afterwards to restore 4-byte alignment.
"""
import os
import sys
import time
import zipfile


def read_entries(path):
    """Return [(name, compress_type, external_attr, create_system, data)] in archive order."""
    out = []
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            out.append((info.filename, info.compress_type, info.external_attr,
                        info.create_system, zf.read(info.filename)))
    return out


def main(argv):
    if len(argv) != 4:
        sys.stderr.write(__doc__)
        return 2
    src_apk, dex_path, out_apk = argv[1], argv[2], argv[3]
    for path in (src_apk, dex_path):
        if not os.path.isfile(path):
            sys.stderr.write("missing input: %s\n" % path)
            return 2

    entries = read_entries(src_apk)
    names = set(name for name, _c, _e, _s, _d in entries)
    if "classes.dex" in names:
        sys.stderr.write("classes.dex already present in %s\n" % src_apk)
        return 1
    with open(dex_path, "rb") as fh:
        dex = fh.read()

    tmp = out_apk + ".part"
    if os.path.exists(tmp):
        os.remove(tmp)

    def add(zf, name, ctype, ext_attr, create_system, data):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ctype
        info.external_attr = ext_attr
        info.create_system = create_system
        zf.writestr(info, data)

    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, ctype, ext_attr, create_system, data in entries:
            add(zf, name, ctype, ext_attr, create_system, data)
        add(zf, "classes.dex", zipfile.ZIP_DEFLATED, 0x81A40000, 0, dex)

    # sanity pass on the archive we are about to hand to zipalign
    with zipfile.ZipFile(tmp) as zf:
        bad = zf.testzip()
        if bad is not None:
            os.remove(tmp)
            sys.stderr.write("corrupt zip entry after repack: %s\n" % bad)
            return 1
        total = len(zf.namelist())

    if os.path.exists(out_apk):
        os.remove(out_apk)
    os.replace(tmp, out_apk)
    sys.stdout.write("inject_dex: %d entries (classes.dex %d bytes) -> %s\n"
                     % (total, len(dex), os.path.basename(out_apk)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
