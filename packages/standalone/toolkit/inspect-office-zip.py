"""Bound office ZIP expansion using only the central directory, without extracting entries."""
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 10_000:
        raise ValueError("Office ZIP exceeds the 10,000 entries limit")
    total = sum(entry.file_size for entry in entries)
    if total > 512 * 1024 ** 2:
        raise ValueError("Office ZIP exceeds the 512 MiB total uncompressed size limit")
    if any(entry.file_size > 256 * 1024 ** 2 for entry in entries):
        raise ValueError("Office ZIP exceeds the 256 MiB entry uncompressed size limit")
    compressed = sum(entry.compress_size for entry in entries)
    if total > 100 * compressed:
        raise ValueError("Office ZIP exceeds the 100:1 expansion ratio limit")
