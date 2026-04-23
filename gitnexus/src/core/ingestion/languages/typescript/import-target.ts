/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 *
 * Delegates to the existing standard-strategy resolver
 * (`resolveImportPath`) so tsconfig path aliases (`@/`, `~/`, …) and
 * suffix-based resolution follow the same rules as the legacy path.
 *
 * The `WorkspaceIndex` is opaque at the shared contract layer; we
 * narrow it to a TypeScript-shaped context that carries `fromFile` +
 * the full `allFilePaths` set + the optional `tsconfigPaths` the
 * resolver reads.
 *
 * Returning `null` lets the finalize algorithm mark the edge as
 * `linkStatus: 'unresolved'`.
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { resolveImportPath } from '../../import-resolvers/standard.js';
import type { TsconfigPaths } from '../../language-config.js';

export interface TsResolveContext {
  readonly fromFile: string;
  /** Mutable `Set` because the standard resolver consumes `Set<string>`.
   *  Callers holding a `ReadonlySet` should copy via `new Set(...)`. */
  readonly allFilePaths: Set<string>;
  /** Repo file list, normalized (lowercased) for suffix matching. May
   *  be supplied by the orchestrator; if absent we derive it on the
   *  fly from `allFilePaths`. */
  readonly allFileList?: readonly string[];
  readonly normalizedFileList?: readonly string[];
  /** Per-call resolution cache to dedupe repeated lookups. */
  readonly resolveCache?: Map<string, string | null>;
  /** Parsed tsconfig path-aliases. `null` = no aliases configured. */
  readonly tsconfigPaths?: TsconfigPaths | null;
  /** JavaScript vs TypeScript switch — affects the extensions the
   *  resolver tries. Defaults to TypeScript. */
  readonly language?: SupportedLanguages.TypeScript | SupportedLanguages.JavaScript;
}

export function resolveTsImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = workspaceIndex as TsResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') {
    // Dynamic imports carry `targetRaw` only for diagnostics; when
    // the expression isn't a string literal we can't resolve a file.
    if (parsedImport.targetRaw === null) return null;
    // A string-literal dynamic import (`import('./m')`) resolves the
    // same way as a static import, so we fall through.
  }
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const language = ctx.language ?? SupportedLanguages.TypeScript;
  const allFileList = ctx.allFileList ?? Array.from(ctx.allFilePaths);
  const normalizedFileList = ctx.normalizedFileList ?? allFileList.map((f) => f.toLowerCase());
  const resolveCache = ctx.resolveCache ?? new Map<string, string | null>();

  return resolveImportPath(
    ctx.fromFile,
    parsedImport.targetRaw,
    ctx.allFilePaths,
    allFileList as string[],
    normalizedFileList as string[],
    resolveCache,
    language,
    ctx.tsconfigPaths ?? null,
  );
}
