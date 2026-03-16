import type { SyntaxNode } from '../utils.js';

/** Known single-arg nullable wrapper types that unwrap to their inner type
 *  for receiver resolution. Optional<User> → "User", Option<User> → "User".
 *  Only nullable wrappers — NOT containers (List, Vec) or async wrappers (Promise, Future).
 *  See call-processor.ts WRAPPER_GENERICS for the full set used in return-type inference. */
const NULLABLE_WRAPPER_TYPES = new Set([
  'Optional',    // Java
  'Option',      // Rust, Scala
  'Maybe',       // Haskell-style, Kotlin Arrow
]);

/**
 * Extract the simple type name from a type AST node.
 * Handles generic types (e.g., List<User> → List), qualified names
 * (e.g., models.User → User), and nullable types (e.g., User? → User).
 * Returns undefined for complex types (unions, intersections, function types).
 */
export const extractSimpleTypeName = (typeNode: SyntaxNode): string | undefined => {
  // Direct type identifier (includes Ruby 'constant' for class names)
  if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier'
    || typeNode.type === 'simple_identifier' || typeNode.type === 'constant') {
    return typeNode.text;
  }

  // Qualified/scoped names: take the last segment (e.g., models.User → User, Models::User → User)
  if (typeNode.type === 'scoped_identifier' || typeNode.type === 'qualified_identifier'
    || typeNode.type === 'scoped_type_identifier' || typeNode.type === 'qualified_name'
    || typeNode.type === 'qualified_type'
    || typeNode.type === 'member_expression' || typeNode.type === 'member_access_expression'
    || typeNode.type === 'attribute'
    || typeNode.type === 'scope_resolution'
    || typeNode.type === 'selector_expression') {
    const last = typeNode.lastNamedChild;
    if (last && (last.type === 'type_identifier' || last.type === 'identifier'
      || last.type === 'simple_identifier' || last.type === 'name'
      || last.type === 'constant' || last.type === 'property_identifier'
      || last.type === 'field_identifier')) {
      return last.text;
    }
  }

  // Generic types: extract the base type (e.g., List<User> → List)
  // For nullable wrappers (Optional<User>, Option<User>), unwrap to inner type.
  if (typeNode.type === 'generic_type' || typeNode.type === 'parameterized_type') {
    const base = typeNode.childForFieldName('name')
      ?? typeNode.childForFieldName('type')
      ?? typeNode.firstNamedChild;
    if (!base) return undefined;
    const baseName = extractSimpleTypeName(base);
    // Unwrap known nullable wrappers: Optional<User> → User, Option<User> → User
    if (baseName && NULLABLE_WRAPPER_TYPES.has(baseName)) {
      const args = extractGenericTypeArgs(typeNode);
      if (args.length >= 1) return args[0];
    }
    return baseName;
  }

  // Nullable types (Kotlin User?, C# User?)
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // Nullable union types (TS/JS: User | null, User | undefined, User | null | undefined)
  // Extract the single non-null/undefined type from the union.
  if (typeNode.type === 'union_type') {
    const nonNullTypes: SyntaxNode[] = [];
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const child = typeNode.namedChild(i);
      if (!child) continue;
      // Skip null/undefined/void literal types
      const text = child.text;
      if (text === 'null' || text === 'undefined' || text === 'void') continue;
      nonNullTypes.push(child);
    }
    // Only unwrap if exactly one meaningful type remains
    if (nonNullTypes.length === 1) {
      return extractSimpleTypeName(nonNullTypes[0]);
    }
  }

  // Type annotations that wrap the actual type (TS/Python: `: Foo`, Kotlin: user_type)
  if (typeNode.type === 'type_annotation' || typeNode.type === 'type'
    || typeNode.type === 'user_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // Pointer/reference types (C++, Rust): User*, &User, &mut User
  if (typeNode.type === 'pointer_type' || typeNode.type === 'reference_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // PHP primitive_type (string, int, float, bool)
  if (typeNode.type === 'primitive_type') {
    return typeNode.text;
  }

  // PHP named_type / optional_type
  if (typeNode.type === 'named_type' || typeNode.type === 'optional_type') {
    const inner = typeNode.childForFieldName('name') ?? typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // Name node (PHP)
  if (typeNode.type === 'name') {
    return typeNode.text;
  }

  return undefined;
};

/**
 * Extract variable name from a declarator or pattern node.
 * Returns the simple identifier text, or undefined for destructuring/complex patterns.
 */
export const extractVarName = (node: SyntaxNode): string | undefined => {
  if (node.type === 'identifier' || node.type === 'simple_identifier'
    || node.type === 'variable_name' || node.type === 'name'
    || node.type === 'constant') {
    return node.text;
  }
  // variable_declarator (Java/C#): has a 'name' field
  if (node.type === 'variable_declarator') {
    const nameChild = node.childForFieldName('name');
    if (nameChild) return extractVarName(nameChild);
  }
  // Rust: let mut x = ... — mut_pattern wraps an identifier
  if (node.type === 'mut_pattern') {
    const inner = node.firstNamedChild;
    if (inner) return extractVarName(inner);
  }
  return undefined;
};

/** Node types for function/method parameters with type annotations */
export const TYPED_PARAMETER_TYPES = new Set([
  'required_parameter',      // TS: (x: Foo)
  'optional_parameter',      // TS: (x?: Foo)
  'formal_parameter',        // Java/Kotlin
  'parameter',               // C#/Rust/Go/Python/Swift
  'parameter_declaration',   // C/C++ void f(Type name)
  'simple_parameter',        // PHP function(Foo $x)
  'property_promotion_parameter', // PHP 8.0+ constructor promotion: __construct(private Foo $x)
]);

/**
 * Extract type arguments from a generic type node.
 * e.g., List<User, String> → ['User', 'String'], Vec<User> → ['User']
 *
 * Used by extractSimpleTypeName to unwrap nullable wrappers (Optional<User> → User).
 *
 * Handles language-specific AST structures:
 * - TS/Java/Rust/Go: generic_type > type_arguments > type nodes
 * - C#:              generic_type > type_argument_list > type nodes
 * - Kotlin:          generic_type > type_arguments > type_projection > type nodes
 *
 * Note: Go slices/maps use slice_type/map_type, not generic_type — those are
 * NOT handled here. Use language-specific extractors for Go container types.
 *
 * @param typeNode A generic_type or parameterized_type AST node (or any node —
 *   returns [] for non-generic types).
 * @returns Array of resolved type argument names. Unresolvable arguments are omitted.
 */
export const extractGenericTypeArgs = (typeNode: SyntaxNode): string[] => {
  // Unwrap wrapper nodes that may sit above the generic_type
  if (typeNode.type === 'type_annotation' || typeNode.type === 'type'
    || typeNode.type === 'user_type' || typeNode.type === 'nullable_type'
    || typeNode.type === 'optional_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractGenericTypeArgs(inner);
    return [];
  }

  // Only process generic/parameterized type nodes
  if (typeNode.type !== 'generic_type' && typeNode.type !== 'parameterized_type') {
    return [];
  }

  // Find the type_arguments / type_argument_list child
  let argsNode: SyntaxNode | null = null;
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child && (child.type === 'type_arguments' || child.type === 'type_argument_list')) {
      argsNode = child;
      break;
    }
  }
  if (!argsNode) return [];

  const result: string[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    let argNode = argsNode.namedChild(i);
    if (!argNode) continue;

    // Kotlin: type_arguments > type_projection > user_type > type_identifier
    if (argNode.type === 'type_projection') {
      argNode = argNode.firstNamedChild;
      if (!argNode) continue;
    }

    const name = extractSimpleTypeName(argNode);
    if (name) result.push(name);
  }

  return result;
};

/**
 * Match Ruby constructor assignment: `user = User.new` or `service = Models::User.new`.
 * Returns { varName, calleeName } or undefined if the node is not a Ruby constructor assignment.
 * Handles both simple constants and scope_resolution (namespaced) receivers.
 */
export const extractRubyConstructorAssignment = (
  node: SyntaxNode,
): { varName: string; calleeName: string } | undefined => {
  if (node.type !== 'assignment') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'identifier' && left.type !== 'constant') return undefined;
  if (right.type !== 'call') return undefined;
  const method = right.childForFieldName('method');
  if (!method || method.text !== 'new') return undefined;
  const receiver = right.childForFieldName('receiver');
  if (!receiver) return undefined;
  let calleeName: string;
  if (receiver.type === 'constant') {
    calleeName = receiver.text;
  } else if (receiver.type === 'scope_resolution') {
    // Models::User → extract last segment "User"
    const last = receiver.lastNamedChild;
    if (!last || last.type !== 'constant') return undefined;
    calleeName = last.text;
  } else {
    return undefined;
  }
  return { varName: left.text, calleeName };
};

/**
 * Check if an AST node has an explicit type annotation.
 * Checks both named fields ('type') and child nodes ('type_annotation').
 * Used by constructor binding scanners to skip annotated declarations.
 */
export const hasTypeAnnotation = (node: SyntaxNode): boolean => {
  if (node.childForFieldName('type')) return true;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'type_annotation') return true;
  }
  return false;
};

/** Bare nullable keywords that should not produce a receiver binding. */
const NULLABLE_KEYWORDS = new Set(['null', 'undefined', 'void', 'None', 'nil']);

/**
 * Strip nullable wrappers from a type name string.
 * Used by both lookupInEnv (TypeEnv annotations) and extractReturnTypeName
 * (return-type text) to normalize types before receiver lookup.
 *
 *   "User | null"           → "User"
 *   "User | undefined"      → "User"
 *   "User | null | undefined" → "User"
 *   "User?"                 → "User"
 *   "User | Repo"           → undefined  (genuine union — refuse)
 *   "null"                  → undefined
 */
export const stripNullable = (typeName: string): string | undefined => {
  let text = typeName.trim();
  if (!text) return undefined;

  if (NULLABLE_KEYWORDS.has(text)) return undefined;

  // Strip nullable suffix: User? → User
  if (text.endsWith('?')) text = text.slice(0, -1).trim();

  // Strip union with null/undefined/None/nil/void
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim()).filter(p =>
      p !== '' && !NULLABLE_KEYWORDS.has(p)
    );
    if (parts.length === 1) return parts[0];
    return undefined; // genuine union or all-nullable — refuse
  }

  return text || undefined;
};

/**
 * Unwrap an await_expression to get the inner value.
 * Returns the node itself if not an await_expression, or null if input is null.
 */
export const unwrapAwait = (node: SyntaxNode | null): SyntaxNode | null => {
  if (!node) return null;
  return node.type === 'await_expression' ? node.firstNamedChild : node;
};

/**
 * Extract the callee name from a call_expression node.
 * Navigates to the 'function' field (or first named child) and extracts a simple type name.
 */
export const extractCalleeName = (callNode: SyntaxNode): string | undefined => {
  const func = callNode.childForFieldName('function') ?? callNode.firstNamedChild;
  if (!func) return undefined;
  return extractSimpleTypeName(func);
};

/** Find the first named child with the given node type */
export const findChildByType = (node: SyntaxNode, type: string): SyntaxNode | null => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
};

// Internal helper: extract the first comma-separated argument from a string,
// respecting nested angle-bracket and square-bracket depth.
function extractFirstArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '<' || ch === '[') depth++;
    else if (ch === '>' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * Extract element type from a container type string.
 * Uses bracket-balanced parsing (no regex) for generic argument extraction.
 * Returns undefined for ambiguous or unparseable strings.
 *
 * Handles:
 * - Array<User>    → User  (generic angle brackets)
 * - User[]         → User  (array suffix)
 * - []User         → User  (Go slice prefix)
 * - List[User]     → User  (Python subscript)
 * - [User]         → User  (Swift array sugar)
 * - vector<User>   → User  (C++ container)
 * - Vec<User>      → User  (Rust container)
 *
 * For multi-argument generics (Map<K, V>), only the first type argument is
 * returned. Returns undefined when the extracted type is not a simple word
 * (e.g., nested generics as element types).
 */
export function extractElementTypeFromString(typeStr: string): string | undefined {
  if (!typeStr || typeStr.length === 0 || typeStr.length > 2048) return undefined;

  // 1. Array suffix: User[] → User
  if (typeStr.endsWith('[]')) {
    const base = typeStr.slice(0, -2).trim();
    return base && /^\w+$/.test(base) ? base : undefined;
  }

  // 2. Go slice prefix: []User → User
  if (typeStr.startsWith('[]')) {
    const element = typeStr.slice(2).trim();
    return element && /^\w+$/.test(element) ? element : undefined;
  }

  // 3. Swift array sugar: [User] → User
  //    Must start with '[', end with ']', and contain no angle brackets
  //    (to avoid confusing with List[User] handled below).
  if (typeStr.startsWith('[') && typeStr.endsWith(']') && !typeStr.includes('<')) {
    const element = typeStr.slice(1, -1).trim();
    return element && /^\w+$/.test(element) ? element : undefined;
  }

  // 4. Generic bracket-balanced extraction: Array<User> / List[User] / Vec<User>
  //    Find the first opening bracket (< or [) and pick the one that appears first.
  const openAngle = typeStr.indexOf('<');
  const openSquare = typeStr.indexOf('[');

  let openIdx = -1;
  let openChar = '';
  let closeChar = '';

  if (openAngle >= 0 && (openSquare < 0 || openAngle < openSquare)) {
    openIdx = openAngle;
    openChar = '<';
    closeChar = '>';
  } else if (openSquare >= 0) {
    openIdx = openSquare;
    openChar = '[';
    closeChar = ']';
  }

  if (openIdx < 0) return undefined;

  // Walk bracket-balanced from the character after the opening bracket to find
  // the matching close bracket, tracking depth for nested brackets.
  let depth = 0;
  const start = openIdx + 1;
  for (let i = start; i < typeStr.length; i++) {
    const ch = typeStr[i];
    if (ch === openChar || ch === '<' || ch === '[') {
      depth++;
    } else if (ch === closeChar || ch === '>' || ch === ']') {
      if (depth === 0) {
        // Found the matching close bracket — extract and validate first arg.
        const inner = typeStr.slice(start, i).trim();
        const firstArg = extractFirstArg(inner);
        return firstArg && /^\w+$/.test(firstArg) ? firstArg : undefined;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      // Top-level comma before the matching close bracket — take the text before it.
      const arg = typeStr.slice(start, i).trim();
      return arg && /^\w+$/.test(arg) ? arg : undefined;
    }
  }

  return undefined;
}
