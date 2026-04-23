/**
 * TypeScript `ScopeResolver` registered in `SCOPE_RESOLVERS` and
 * consumed by the generic `runScopeResolution` orchestrator
 * (RFC #909 Ring 3).
 *
 * Third migration after Python and C#. Follows the same minimal
 * wiring-only pattern — per-hook logic lives in the sibling modules
 * (`arity.ts`, `merge-bindings.ts`, `import-target.ts`, etc.).
 *
 * See ./index.ts for the per-module rationale and the full list of
 * known limitations. The canonical capture vocabulary is pinned in
 * ./query.ts (TYPESCRIPT_SCOPE_QUERY constant).
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { typescriptProvider } from '../typescript.js';
import {
  typescriptArityCompatibility,
  typescriptMergeBindings,
  resolveTsImportTarget,
  type TsResolveContext,
} from './index.js';

const typescriptScopeResolver: ScopeResolver = {
  language: SupportedLanguages.TypeScript,
  languageProvider: typescriptProvider,
  importEdgeReason: 'typescript-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    // Copy the orchestrator's `ReadonlySet` into a `Set` because the
    // underlying standard resolver is typed to receive `Set<string>`
    // (it uses the set to scan candidate resolutions). O(N) copy
    // once per import — cost is trivial next to parsing.
    const ws: TsResolveContext = {
      fromFile,
      allFilePaths: new Set(allFilePaths),
      // tsconfigPaths / pre-normalized lists would be populated by the
      // orchestrator when available; absent here we let the adapter
      // derive them on the fly.
    };
    return resolveTsImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  // TypeScript declaration merging + LEGB: local > import > wildcard,
  // separated by declaration space (value / type / namespace). The
  // per-scope id is unused (shadowing is computed from origin + def.type),
  // so we don't need to synthesize a Scope here.
  mergeBindings: (existing, incoming) => [...typescriptMergeBindings([...existing, ...incoming])],

  // Adapter: typescriptArityCompatibility uses (def, callsite); the
  // ScopeResolver contract is (callsite, def).
  arityCompatibility: (callsite, def) => typescriptArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // TypeScript uses `super` for super-class dispatch as a plain
  // identifier or as `super()` in constructors. Match both — `super`
  // on its own (`super.foo`, `super[x]`) and `super(...)` (constructor
  // chain). This also correctly rejects identifiers that merely
  // contain the substring `super` (e.g. `superman`).
  isSuperReceiver: (text) => /^super(\s*\(|\s*\.|\s*\[|\s*$)/.test(text.trim()),

  // TypeScript is statically typed — field-fallback heuristic off
  // (the type-binding layer produces precise owner types). Return-
  // type propagation across imports on (matches the legacy DAG's
  // behavior: explicit return-type annotations flow across `export`
  // boundaries and resolve chained member calls).
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  // TypeScript uses `.values()` / `.keys()` method-call syntax for
  // collection views — no property-style accessors like C#'s
  // `Dictionary<K,V>.Values`. Leave `unwrapCollectionAccessor`
  // undefined and let the regular member-call branch handle them.
  //
  // `collapseMemberCallsByCallerTarget` left undefined (= false) —
  // TypeScript legacy DAG emits one edge per call site, so
  // per-site dedup is the parity target.
  //
  // `populateNamespaceSiblings` left undefined — TypeScript requires
  // an explicit `import` / namespace augmentation for cross-file
  // visibility; there's no implicit same-namespace sibling rule
  // like C#'s.
  //
  // `hoistTypeBindingsToModule` — `tsBindingScopeFor` DOES hoist
  // method return-type bindings to the enclosing Module scope
  // (mirrors C#), so enable the walk-up that lets the compound-
  // receiver resolver find them.
  hoistTypeBindingsToModule: true,
};

export { typescriptScopeResolver };
