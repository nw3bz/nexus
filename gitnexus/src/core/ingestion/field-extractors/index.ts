// gitnexus/src/core/ingestion/field-extractors/index.ts

/**
 * Field Extractors Index
 * 
 * Language-specific field extractors for extracting field/property definitions
 * from class/struct/interface declarations across supported languages.
 * 
 * Each extractor:
 * 1. Extends BaseFieldExtractor
 * 2. Implements isTypeDeclaration() to recognize type declarations
 * 3. Implements extract() to pull field definitions with:
 *    - Name and type
 *    - Visibility modifiers
 *    - Static/readonly flags
 */

import type { FieldExtractor } from '../field-extractor.js';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import { typescriptFieldExtractor, TypeScriptFieldExtractor } from './typescript.js';

// Re-export for direct usage
export { typescriptFieldExtractor, TypeScriptFieldExtractor };

/**
 * Registry of all available field extractors.
 * Populated lazily on first access.
 */
let extractorRegistry: Map<SupportedLanguages, FieldExtractor> | null = null;

/**
 * Get all available field extractors.
 * Returns a map from language to extractor instance.
 */
export function getFieldExtractors(): Map<SupportedLanguages, FieldExtractor> {
  if (!extractorRegistry) {
    extractorRegistry = new Map();
    
    // Register TypeScript extractor
    extractorRegistry.set(SupportedLanguages.TypeScript, typescriptFieldExtractor);
    
    // Future: Add other language extractors here
    // extractorRegistry.set(SupportedLanguages.Java, javaFieldExtractor);
    // extractorRegistry.set(SupportedLanguages.CSharp, csharpFieldExtractor);
    // extractorRegistry.set(SupportedLanguages.Python, pythonFieldExtractor);
    // etc.
  }
  
  return extractorRegistry;
}

/**
 * Get a field extractor for a specific language.
 * Returns undefined if no extractor is available for that language.
 */
export function getFieldExtractor(language: SupportedLanguages): FieldExtractor | undefined {
  return getFieldExtractors().get(language);
}

/**
 * Check if a field extractor is available for a given language.
 */
export function hasFieldExtractor(language: SupportedLanguages): boolean {
  return getFieldExtractors().has(language);
}
