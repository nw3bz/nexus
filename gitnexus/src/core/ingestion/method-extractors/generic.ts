// gitnexus/src/core/ingestion/method-extractors/generic.ts

/**
 * Generic table-driven method extractor factory.
 *
 * Mirrors field-extractors/generic.ts — define a config per language and
 * generate extractors from configs. No class hierarchy needed.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  MethodExtractor,
  MethodExtractorContext,
  MethodExtractionConfig,
  ExtractedMethods,
  MethodInfo,
} from '../method-types.js';

/**
 * Create a MethodExtractor from a declarative config.
 */
export function createMethodExtractor(config: MethodExtractionConfig): MethodExtractor {
  const typeDeclarationSet = new Set(config.typeDeclarationNodes);
  const methodNodeSet = new Set(config.methodNodeTypes);
  const bodyNodeSet = new Set(config.bodyNodeTypes);

  return {
    language: config.language,

    isTypeDeclaration(node: SyntaxNode): boolean {
      return typeDeclarationSet.has(node.type);
    },

    extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null {
      if (!typeDeclarationSet.has(node.type)) return null;

      // Try field-based name first, then walk children for type_identifier
      // (Kotlin class_declaration has no 'name' field — the type_identifier is a direct child)
      let ownerFqn: string | undefined;
      const nameField = node.childForFieldName('name');
      if (nameField) {
        ownerFqn = nameField.text;
      } else {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child && child.type === 'type_identifier') {
            ownerFqn = child.text;
            break;
          }
        }
      }
      if (!ownerFqn) return null;
      const methods: MethodInfo[] = [];

      const bodies = findBodies(node, bodyNodeSet);
      for (const body of bodies) {
        extractMethodsFromBody(body, node, context, config, methodNodeSet, methods);
      }

      return { ownerFqn, methods };
    },
  };
}

function findBodies(node: SyntaxNode, bodyNodeSet: Set<string>): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const bodyField = node.childForFieldName('body');
  if (bodyField && bodyNodeSet.has(bodyField.type)) {
    result.push(bodyField);
    // Also check nested body containers (e.g., enum_body > enum_body_declarations)
    addNestedBodies(bodyField, bodyNodeSet, result);
    return result;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && bodyNodeSet.has(child.type)) {
      result.push(child);
    }
  }
  if (result.length === 0 && bodyField) {
    result.push(bodyField);
    addNestedBodies(bodyField, bodyNodeSet, result);
  }
  return result;
}

function addNestedBodies(parent: SyntaxNode, bodyNodeSet: Set<string>, out: SyntaxNode[]): void {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child && bodyNodeSet.has(child.type) && !out.includes(child)) {
      out.push(child);
    }
  }
}

function extractMethodsFromBody(
  body: SyntaxNode,
  ownerNode: SyntaxNode,
  context: MethodExtractorContext,
  config: MethodExtractionConfig,
  methodNodeSet: Set<string>,
  out: MethodInfo[],
): void {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;

    if (methodNodeSet.has(child.type)) {
      const method = buildMethod(child, ownerNode, context, config);
      if (method) out.push(method);
    }
  }
}

function buildMethod(
  node: SyntaxNode,
  ownerNode: SyntaxNode,
  context: MethodExtractorContext,
  config: MethodExtractionConfig,
): MethodInfo | null {
  const name = config.extractName(node);
  if (!name) return null;

  return {
    name,
    returnType: config.extractReturnType(node) ?? null,
    parameters: config.extractParameters(node),
    visibility: config.extractVisibility(node),
    isStatic: config.isStatic(node),
    isAbstract: config.isAbstract(node, ownerNode),
    isFinal: config.isFinal(node),
    annotations: config.extractAnnotations?.(node) ?? [],
    sourceFile: context.filePath,
    line: node.startPosition.row + 1,
  };
}
