#!/usr/bin/env python3
"""Create an exclusive private input skeleton. Local files only, no AWS calls."""
import argparse
import json
import os
from pathlib import Path
import stat


def prepare(directory):
    directory = Path(directory)
    if not directory.is_absolute() or directory.resolve() != directory:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
    path = directory/'aws-input.json'
    template = json.loads(Path(__file__).with_name('private-input.example.json').read_text())
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(template, output, indent=2); output.write('\n'); output.flush(); os.fsync(output.fileno())
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
    print('PRIVATE_INPUT_SKELETON_CREATED_NO_AWS_CALLS')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-directory', required=True)
    args = parser.parse_args()
    try: prepare(args.private_directory)
    except Exception:
        print('PRIVATE_INPUT_CREATION_REFUSED'); raise SystemExit(1)
