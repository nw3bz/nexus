import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ContractRegistry } from './types.js';

/**
 * Build an unpredictable suffix for atomic-write tmp files. Replaces the
 * previous `Date.now()` pattern which CodeQL flagged as
 * js/insecure-temporary-file: a guessable suffix in a writable directory
 * lets a co-located attacker pre-create or symlink the tmp path before the
 * write lands.
 */
const tmpSuffix = (): string => randomBytes(8).toString('hex');

const CONTRACTS_FILE = 'contracts.json';

export function getDefaultGitnexusDir(): string {
  return process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus');
}

export function getGroupsBaseDir(gitnexusDir?: string): string {
  return path.join(gitnexusDir || getDefaultGitnexusDir(), 'groups');
}

const GROUP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateGroupName(name: string): void {
  if (!GROUP_NAME_RE.test(name)) {
    throw new Error(
      `Invalid group name "${name}". Names must start with a letter or digit and contain only [a-zA-Z0-9_-].`,
    );
  }
}

export function getGroupDir(gitnexusDir: string, groupName: string): string {
  validateGroupName(groupName);
  return path.join(gitnexusDir, 'groups', groupName);
}

export async function writeContractRegistry(
  groupDir: string,
  registry: ContractRegistry,
): Promise<void> {
  const targetPath = path.join(groupDir, CONTRACTS_FILE);
  const tmpPath = `${targetPath}.tmp.${tmpSuffix()}`;

  // `flag: 'wx'` opens the tmp file with O_EXCL — refuses to overwrite an
  // existing path, closing the symlink/pre-create attack window CodeQL
  // js/insecure-temporary-file flags. The unpredictable suffix above means
  // collisions are negligible; if one happens (extremely unlikely) the
  // caller sees an EEXIST error and can retry.
  await fsp.writeFile(tmpPath, JSON.stringify(registry, null, 2), {
    encoding: 'utf-8',
    flag: 'wx',
  });
  await fsp.rename(tmpPath, targetPath);
}

export async function readContractRegistry(groupDir: string): Promise<ContractRegistry | null> {
  const filePath = path.join(groupDir, CONTRACTS_FILE);
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content) as ContractRegistry;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listGroups(gitnexusDir?: string): Promise<string[]> {
  const groupsDir = getGroupsBaseDir(gitnexusDir);
  try {
    const entries = await fsp.readdir(groupsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const yamlPath = path.join(groupsDir, entry.name, 'group.yaml');
        if (fs.existsSync(yamlPath)) {
          names.push(entry.name);
        }
      }
    }
    return names;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function createGroupDir(
  gitnexusDir: string,
  groupName: string,
  force: boolean = false,
): Promise<string> {
  const groupDir = getGroupDir(gitnexusDir, groupName);
  if (fs.existsSync(path.join(groupDir, 'group.yaml')) && !force) {
    throw new Error(`Group "${groupName}" already exists. Use --force to overwrite.`);
  }
  await fsp.mkdir(groupDir, { recursive: true });

  const template = `version: 1
name: ${groupName}
description: ""

repos: {}

links: []

packages: {}

detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true

matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
  # exclude_links_paths: [/ping, /health, /healthcheck]
  # exclude_links_param_only_paths: false
`;
  // Writing group.yaml with `flag: 'wx'` is exclusive-create — refuses to
  // overwrite an existing file. Combined with the existence check above
  // (line ~80) this closes the TOCTOU window between check and write that
  // CodeQL js/insecure-temporary-file flags. When `force=true` we
  // explicitly switch to default write semantics so the function still
  // overwrites as documented.
  await fsp.writeFile(path.join(groupDir, 'group.yaml'), template, {
    encoding: 'utf-8',
    flag: force ? 'w' : 'wx',
  });
  return groupDir;
}
