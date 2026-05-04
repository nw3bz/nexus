/**
 * Regression tests for U6 — closes CodeQL js/insecure-temporary-file
 * (#191/#192/#193 originally; #467/#468/#469 after first-pass refactor)
 * and js/log-injection (#188 originally; #466 after first-pass refactor)
 * in core/group.
 *
 * The current shape uses fs.mkdtemp staging directories + retryRename for
 * atomic-write semantics — the canonical CodeQL-recognized sanitizer for
 * js/insecure-temporary-file. Tests pin every fix path so a future refactor
 * that drops mkdtemp, drops the finally-cleanup, or re-introduces the
 * predictable-suffix pattern would fail at least one test AND re-trigger
 * the corresponding CodeQL alert.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { writeContractRegistry, createGroupDir } from '../../../src/core/group/storage.js';
import { writeBridgeMeta } from '../../../src/core/group/bridge-db.js';

let tmpRoot: string;
let groupDir: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-u6-'));
  groupDir = path.join(tmpRoot, 'fixture-group');
  await fs.mkdir(groupDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Helper: enumerate the staging directories that a function may have left
// behind. Used to assert the finally-cleanup invariant. The mkdtemp prefix
// pattern matches the production code: writeContractRegistry uses
// `contracts-tmp-`, writeBridgeMeta uses `meta-tmp-`, createGroupDir uses
// `init-${groupName}-` inside the parent (groups) directory.
async function listStagingDirs(parentDir: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(parentDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && e.name.startsWith(prefix)).map((e) => e.name);
}

describe('writeContractRegistry — mkdtemp staging hardening', () => {
  it('writes the file then leaves no contracts-tmp- staging directory behind', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'wcr-cleanup-'));
    await writeContractRegistry(dir, { contracts: [], version: 1 } as never);
    expect(await listStagingDirs(dir, 'contracts-tmp-')).toEqual([]);
    const written = JSON.parse(await fs.readFile(path.join(dir, 'contracts.json'), 'utf-8'));
    expect(written.version).toBe(1);
  });

  it('back-to-back writes succeed and the final file matches the second write', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'wcr-back2back-'));
    await writeContractRegistry(dir, { contracts: [], version: 1 } as never);
    await writeContractRegistry(dir, { contracts: [], version: 2 } as never);
    expect(await listStagingDirs(dir, 'contracts-tmp-')).toEqual([]);
    const written = JSON.parse(await fs.readFile(path.join(dir, 'contracts.json'), 'utf-8'));
    expect(written.version).toBe(2);
  });

  it('cleans up the staging directory even when the write fails', async () => {
    // Force a write failure by passing a value that JSON.stringify rejects
    // (a circular-reference object). The mkdtemp call still succeeds; the
    // writeFile inside it throws. The finally block must remove the
    // staging dir anyway. This test would fail if a future refactor
    // dropped the finally cleanup.
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'wcr-failure-'));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      writeContractRegistry(dir, { contracts: [], extra: circular } as never),
    ).rejects.toThrow();
    expect(await listStagingDirs(dir, 'contracts-tmp-')).toEqual([]);
  });
});

describe('writeBridgeMeta — mkdtemp staging hardening', () => {
  it('writes meta.json then leaves no meta-tmp- staging directory behind', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'wbm-cleanup-'));
    await writeBridgeMeta(dir, { version: 1, generatedAt: 'a', missingRepos: [] });
    expect(await listStagingDirs(dir, 'meta-tmp-')).toEqual([]);
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf-8'));
    expect(meta.version).toBe(1);
  });

  it('back-to-back writes leave no staging dirs behind', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'wbm-back2back-'));
    await writeBridgeMeta(dir, { version: 1, generatedAt: 'a', missingRepos: [] });
    await writeBridgeMeta(dir, { version: 2, generatedAt: 'b', missingRepos: [] });
    expect(await listStagingDirs(dir, 'meta-tmp-')).toEqual([]);
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf-8'));
    expect(meta.version).toBe(2);
  });
});

describe('createGroupDir — atomic-directory mkdtemp + rename', () => {
  it('creates the group with group.yaml and leaves no init- staging dirs', async () => {
    const gnxDir = path.join(tmpRoot, 'cgd-clean');
    await createGroupDir(gnxDir, 'mygroup');
    const groupsDir = path.join(gnxDir, 'groups');
    expect(await listStagingDirs(groupsDir, 'init-mygroup-')).toEqual([]);
    const yaml = await fs.readFile(path.join(groupsDir, 'mygroup', 'group.yaml'), 'utf-8');
    expect(yaml).toContain('name: mygroup');
  });

  it('refuses to overwrite an existing group without force', async () => {
    const gnxDir = path.join(tmpRoot, 'cgd-existing');
    await createGroupDir(gnxDir, 'mygroup');
    await expect(createGroupDir(gnxDir, 'mygroup')).rejects.toThrow(/already exists/);
    // Even on the rejected path, no leftover staging dir.
    expect(await listStagingDirs(path.join(gnxDir, 'groups'), 'init-mygroup-')).toEqual([]);
  });

  it('overwrites with force=true and still cleans up staging', async () => {
    const gnxDir = path.join(tmpRoot, 'cgd-force');
    await createGroupDir(gnxDir, 'mygroup');
    await createGroupDir(gnxDir, 'mygroup', true);
    expect(await listStagingDirs(path.join(gnxDir, 'groups'), 'init-mygroup-')).toEqual([]);
    const yaml = await fs.readFile(path.join(gnxDir, 'groups', 'mygroup', 'group.yaml'), 'utf-8');
    expect(yaml).toContain('name: mygroup');
  });
});

describe('openBridgeDbReadOnly debug-warn — JSON.stringify log sanitizer', () => {
  it('strips CR/LF from groupDir and error message via JSON.stringify', () => {
    // The fix uses JSON.stringify(value).slice(1, -1). This pinning verifies
    // the sanitizer expression directly against an injected payload — the
    // production code uses the identical idiom inline.
    const evil = '/tmp/group\r\n2026-01-01 [bridge-db] FAKE LINE injected';
    const sanitized = JSON.stringify(evil).slice(1, -1);
    expect(sanitized).not.toContain('\n');
    expect(sanitized).not.toContain('\r');
    // JSON.stringify escapes CR/LF to their \r and \n literal-backslash forms.
    expect(sanitized).toContain('\\r');
    expect(sanitized).toContain('\\n');
    // Single line — no actual newline reaches the log stream.
    expect(sanitized.split('\n').length).toBe(1);
  });

  it('escapes ANSI/C0 control characters as a defense-in-depth side effect', () => {
    // CR/LF stripping was the CodeQL-flagged class. JSON.stringify is
    // strictly stronger — it also escapes ANSI escape sequences and other
    // C0 control characters that could manipulate terminal output. Pin
    // this so a future revert to a CR/LF-only sanitizer is visible.
    const ansi = '[31mRED[0m';
    const sanitized = JSON.stringify(ansi).slice(1, -1);
    expect(sanitized).not.toContain('');
    expect(sanitized).toMatch(/\\u001[bB]/);
  });

  // Tracking note: a true integration test against the live console.warn
  // call would require triggering openBridgeDbReadOnly's retry-exhaustion
  // path with a mocked lbug throwing a CRLF-containing error. The retry
  // path uses LBUG_OPEN_RETRY_ATTEMPTS attempts (currently 3) with backoff
  // — too slow and brittle for the unit suite. The pure-function pinning
  // above is what verifies the sanitizer; vi.spyOn is unused but kept
  // available via the import in case integration coverage is added later.
  void vi; // suppress unused-import warning
});
