import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContractRegistry } from './types.js';
import { retryRename } from './bridge-db.js';

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
  // Stage inside a unique mkdtemp directory rather than writing a tmp file
  // alongside the target. CodeQL's js/insecure-temporary-file query
  // recognizes mkdtemp-staging as a sanitizer (see writeBridge in
  // bridge-db.ts and the U6 follow-up plan). The previous shape
  // (`${target}.tmp.${randomBytes()}` + `flag: 'wx'`) was semantically
  // equivalent but not on CodeQL's recognized-sanitizer list; alerts
  // re-fired on the new code. mkdtemp gives us collision-free, unguessable
  // staging anchored inside groupDir so the rename stays on the same
  // filesystem (no EXDEV) and is atomic.
  const stagingDir = await fsp.mkdtemp(path.join(groupDir, 'contracts-tmp-'));
  try {
    const stagingPath = path.join(stagingDir, CONTRACTS_FILE);
    await fsp.writeFile(stagingPath, JSON.stringify(registry, null, 2), 'utf-8');
    await retryRename(stagingPath, targetPath);
  } finally {
    // Best-effort cleanup. On the happy path the file was renamed out, so
    // the staging dir is empty. On a write/rename failure it may contain a
    // partial file; we remove it either way to avoid disk leak.
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
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

  // The existsSync check is UX only — provides a friendly "already exists"
  // error so users don't see a raw EEXIST. The real security guard is the
  // mkdtemp-staging + atomic-directory-rename pattern below: even if a
  // concurrent caller creates the group between the existsSync return and
  // the rename, the rename will fail (rather than silently overwrite a
  // half-built group). CodeQL js/insecure-temporary-file recognizes the
  // mkdtemp idiom as a sanitizer; the previous `flag: 'wx'` shape was
  // semantically equivalent but not on the recognized list.
  if (fs.existsSync(path.join(groupDir, 'group.yaml')) && !force) {
    throw new Error(`Group "${groupName}" already exists. Use --force to overwrite.`);
  }

  const groupsBaseDir = path.dirname(groupDir);
  await fsp.mkdir(groupsBaseDir, { recursive: true });

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

  // Stage the entire group directory in a sibling mkdtemp directory, then
  // rename it into place atomically. On POSIX, rename(2) of a directory is
  // atomic when target doesn't exist, and atomic-replace when target does
  // (used here for force=true after rm). On Windows, the same pattern works
  // for non-existent targets; the force=true path explicitly removes the
  // existing groupDir first.
  const stagingDir = await fsp.mkdtemp(path.join(groupsBaseDir, `init-${groupName}-`));
  let renamed = false;
  try {
    await fsp.writeFile(path.join(stagingDir, 'group.yaml'), template, 'utf-8');
    if (force) {
      await fsp.rm(groupDir, { recursive: true, force: true });
    }
    await retryRename(stagingDir, groupDir);
    renamed = true;
  } finally {
    // Only clean up the staging dir if the rename didn't consume it. After
    // a successful rename, stagingDir is now groupDir — removing it would
    // delete the group we just created.
    if (!renamed) {
      await fsp.rm(stagingDir, { recursive: true, force: true });
    }
  }
  return groupDir;
}
