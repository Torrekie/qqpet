#!/usr/bin/env python3
"""Check the device Mach-O deployment target and its embedded ad-hoc entitlements."""
import argparse
import plistlib
import struct
from pathlib import Path


def version_number(text):
    parts = [int(part) for part in text.split('.')]
    if not 1 <= len(parts) <= 3 or any(part < 0 or part > 255 for part in parts):
        raise ValueError('Invalid deployment version')
    parts += [0] * (3 - len(parts))
    return parts[0] << 16 | parts[1] << 8 | parts[2]


def architecture_slice(data, architecture):
    if data[:4] != b'\xca\xfe\xba\xbe':  # FAT_MAGIC, big-endian fat_arch entries
        return data
    if len(data) < 8:
        raise ValueError('Truncated fat header')
    count = struct.unpack_from('>I', data, 4)[0]
    if not count or count > (len(data) - 8) // 20:
        raise ValueError('Invalid fat architecture table')
    table_end = 8 + count * 20
    ranges, identities, selected = [], set(), []
    for index in range(count):
        cpu, subtype, offset, size, alignment = struct.unpack_from('>5I', data, 8 + index * 20)
        identity = (cpu, subtype & 0xFFFFFF)
        if identity in identities:
            raise ValueError('Duplicate fat architecture')
        identities.add(identity)
        if alignment > 31 or offset % (1 << alignment):
            raise ValueError('Invalid fat slice alignment')
        if offset < table_end or size < 32 or offset + size > len(data):
            raise ValueError('Invalid fat slice range')
        ranges.append((offset, offset + size))
        if cpu == 0x0100000C and ((subtype & 0xFFFFFF == 2) == (architecture == 'arm64e')):
            selected.append((offset, size, cpu, subtype))
    ranges.sort()
    if any(current[0] < previous[1] for previous, current in zip(ranges, ranges[1:])):
        raise ValueError('Overlapping fat slices')
    if len(selected) != 1:
        raise ValueError('Fat binary does not contain one matching device architecture')
    offset, size, cpu, subtype = selected[0]
    thin = data[offset:offset + size]
    if struct.unpack_from('<3I', thin) != (0xFEEDFACF, cpu, subtype):
        raise ValueError('Fat architecture does not match its Mach-O slice header')
    return thin


def check(file, architecture, minimum, entitlements_file, kind='executable'):
    data = architecture_slice(file.read_bytes(), architecture)
    if len(data) < 32:
        raise ValueError('Truncated executable')
    magic, cpu, subtype, filetype, count, commands_size, _, _ = struct.unpack_from('<8I', data)
    if magic != 0xFEEDFACF or cpu != 0x0100000C or filetype != (8 if kind == 'bundle' else 2):
        raise ValueError('Expected a 64-bit ARM Mach-O ' + kind)
    if (subtype & 0xFFFFFF == 2) != (architecture == 'arm64e'):
        raise ValueError('Mach-O architecture does not match the requested device architecture')
    end = 32 + commands_size
    if end > len(data):
        raise ValueError('Truncated load commands')
    position = 32
    deployment = None
    signature = None
    for _ in range(count):
        if position + 8 > end:
            raise ValueError('Truncated load command')
        command, size = struct.unpack_from('<2I', data, position)
        if size < 8 or position + size > end:
            raise ValueError('Invalid load command size')
        if command == 0x32 and size >= 24:  # LC_BUILD_VERSION
            platform, deployment = struct.unpack_from('<2I', data, position + 8)
            if platform != 2:
                raise ValueError('Mach-O is not linked for the iOS device platform')
        elif command == 0x25 and size >= 16:  # LC_VERSION_MIN_IPHONEOS
            deployment = struct.unpack_from('<I', data, position + 8)[0]
        elif command == 0x1D and size >= 16:  # LC_CODE_SIGNATURE
            signature = struct.unpack_from('<2I', data, position + 8)
        position += size
    if position != end or deployment != version_number(minimum):
        raise ValueError('Mach-O deployment target does not match the requested iOS minimum')
    if not signature:
        raise ValueError('Mach-O has no embedded code signature')
    start, size = signature
    if size < 12 or start + size > len(data):
        raise ValueError('Invalid embedded signature range')
    magic, length, count = struct.unpack_from('>3I', data, start)
    if magic != 0xFADE0CC0 or length > size or 12 + count * 8 > length:
        raise ValueError('Invalid signature superblob')
    actual_entitlements = None
    ad_hoc = False
    for index in range(count):
        slot, offset = struct.unpack_from('>2I', data, start + 12 + index * 8)
        if offset + 8 > length:
            raise ValueError('Invalid signature slot')
        blob_magic, blob_size = struct.unpack_from('>2I', data, start + offset)
        if blob_size < 8 or offset + blob_size > length:
            raise ValueError('Invalid signature blob')
        if slot == 0 and blob_magic == 0xFADE0C02 and blob_size >= 16:
            flags = struct.unpack_from('>I', data, start + offset + 12)[0]
            ad_hoc = bool(flags & 2)
        elif slot == 5 and blob_magic == 0xFADE7171:
            actual_entitlements = plistlib.loads(data[start + offset + 8:start + offset + blob_size].rstrip(b'\0'))
    if not ad_hoc:
        raise ValueError('Expected a local ad-hoc code directory')
    expected = plistlib.loads(entitlements_file.read_bytes())
    if actual_entitlements is None or any(actual_entitlements.get(key) != value for key, value in expected.items()):
        raise ValueError('The embedded signature does not preserve the required entitlements')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=Path)
    parser.add_argument('--kind', choices=['executable', 'bundle'], default='executable')
    parser.add_argument('--arch', choices=['arm64', 'arm64e'], required=True)
    parser.add_argument('--minimum', required=True)
    parser.add_argument('--entitlements', type=Path, required=True)
    options = parser.parse_args()
    try:
        check(options.executable, options.arch, options.minimum, options.entitlements, options.kind)
    except (ValueError, struct.error, OSError, plistlib.InvalidFileException) as error:
        parser.exit(1, f'iOS executable check failed: {error}\n')
