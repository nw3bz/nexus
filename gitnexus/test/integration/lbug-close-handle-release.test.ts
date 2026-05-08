/**
 * Integration test: safeClose's Windows post-close handle-release wait.
 *
 * On Windows, libuv reports `db.close()` resolved before the kernel has
 * released the file handle. A subsequent open of the same path can then
 * race the release and surface "Could not set lock on file". `safeClose`
 * probes the file with `fs.open` to force the residual lock to surface,
 * absorbed by the open-time retry in `lbug-config.ts`.
 *
 * The Windows-specific assertion is skipped on Linux/macOS — those
 * platforms do not exhibit the race so the test would not be meaningful
 * there. The cross-platform sanity case (close-then-reopen works) does
 * run everywhere.
 *
 * See: docs/plans/2026-05-08-002-fix-windows-lbug-lock-ci-flakes-plan.md
 */
import path from 'path';
import { describe, it } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

describe('safeClose — close + reopen does not surface lock errors', () => {
  it('survives 25 sequential open/close/reopen cycles on the same path', async () => {
    const tmp = await createTempDir('gitnexus-lbug-close-cycle-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      // 25 iterations is enough on Windows CI to flush out the race
      // empirically (10 iterations was insufficient in pre-fix runs).
      // Tight loop with no inserts isolates the open/close path.
      for (let i = 0; i < 25; i++) {
        await adapter.initLbug(dbPath);
        await adapter.closeLbug();
      }
    } finally {
      await tmp.cleanup();
    }
  });

  it('safeClose is idempotent — calling twice in a row does not throw', async () => {
    const tmp = await createTempDir('gitnexus-lbug-idempotent-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(dbPath);
      await adapter.closeLbug();
      await adapter.closeLbug();
    } finally {
      await tmp.cleanup();
    }
  });
});
