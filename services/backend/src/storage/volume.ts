// Kamui: tells a network filesystem from a local disk, for the SQLite stores. WAL needs shared
// memory between the processes that open a database, which a network volume (NFS, EFS, SMB)
// does not give, so the stores refuse WAL on one.
import { statfsSync } from 'node:fs';

/** Says whether a directory sits on a network filesystem. Injectable so tests can fake the volume type. */
export type VolumeProbe = (dir: string) => boolean;

// Linux statfs f_type magic numbers (linux/magic.h). EFS mounts as NFSv4, so it reports NFS.
const NETWORK_FS_TYPES = new Set([
  0x6969, // NFS (and EFS)
  0x517b, // SMB
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x5346414f, // AFS
  0x73757245, // Coda
  0x00c36400, // Ceph
]);

/**
 * The default probe. On Linux it reads the filesystem type with statfs; elsewhere (a developer's
 * macOS, where f_type is not a stable magic number) it reports a local disk.
 */
export const isNetworkVolume: VolumeProbe = (dir) => process.platform === 'linux' && NETWORK_FS_TYPES.has(statfsSync(dir).type >>> 0);
