// A KeyValueStore backed by a JSON file, for scripts and servers. It holds the session's private
// key: keep the file out of version control and readable only by you.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyValueStore } from '@kamui/sdk';

export function fileStore(path: string): KeyValueStore {
  const read = (): Record<string, string> => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  const write = (data: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  };
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) => write({ ...read(), [key]: value }),
    removeItem: (key) => {
      const data = read();
      delete data[key];
      write(data);
    },
  };
}
