import { describe, it, expect } from 'vitest';
import { createMethodExtractor } from '../../src/core/ingestion/method-extractors/generic.js';
import {
  javaMethodConfig,
  kotlinMethodConfig,
} from '../../src/core/ingestion/method-extractors/configs/jvm.js';
import type { MethodExtractorContext } from '../../src/core/ingestion/method-types.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

let Kotlin: unknown;
try {
  Kotlin = require('tree-sitter-kotlin');
} catch {
  // Kotlin grammar may not be installed
}

const parser = new Parser();

const parseJava = (code: string) => {
  parser.setLanguage(Java);
  return parser.parse(code);
};

const parseKotlin = (code: string) => {
  if (!Kotlin) throw new Error('tree-sitter-kotlin not available');
  parser.setLanguage(Kotlin as Parser.Language);
  return parser.parse(code);
};

const javaCtx: MethodExtractorContext = {
  filePath: 'Test.java',
  language: SupportedLanguages.Java,
};

const kotlinCtx: MethodExtractorContext = {
  filePath: 'Test.kt',
  language: SupportedLanguages.Kotlin,
};

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

describe('Java MethodExtractor', () => {
  const extractor = createMethodExtractor(javaMethodConfig);

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parseJava('public class Foo { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parseJava('public interface Bar { }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('recognizes enum_declaration', () => {
      const tree = parseJava('public enum Color { RED, GREEN }');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(true);
    });

    it('rejects import_declaration', () => {
      const tree = parseJava('import java.util.List;');
      expect(extractor.isTypeDeclaration(tree.rootNode.child(0)!)).toBe(false);
    });
  });

  describe('extract from class', () => {
    it('extracts public method with parameters', () => {
      const tree = parseJava(`
        public class UserService {
          public User findById(Long id, boolean active) {
            return null;
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('findById');
      expect(m.returnType).toBe('User');
      expect(m.visibility).toBe('public');
      expect(m.isStatic).toBe(false);
      expect(m.isAbstract).toBe(false);
      expect(m.isFinal).toBe(false);
      expect(m.parameters).toHaveLength(2);
      expect(m.parameters[0]).toEqual({
        name: 'id',
        type: 'Long',
        isOptional: false,
        isVariadic: false,
      });
      expect(m.parameters[1]).toEqual({
        name: 'active',
        type: 'boolean',
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts static method', () => {
      const tree = parseJava(`
        public class MathUtils {
          public static int add(int a, int b) {
            return a + b;
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].isStatic).toBe(true);
    });

    it('extracts final method', () => {
      const tree = parseJava(`
        public class Base {
          public final void doSomething() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].isFinal).toBe(true);
    });

    it('extracts private method', () => {
      const tree = parseJava(`
        public class Foo {
          private void helper() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].visibility).toBe('private');
    });

    it('detects package-private (default) visibility', () => {
      const tree = parseJava(`
        public class Foo {
          void internalMethod() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].visibility).toBe('package');
    });

    it('extracts annotations', () => {
      const tree = parseJava(`
        public class Service {
          @Override
          public String toString() { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].annotations).toContain('@Override');
    });

    it('extracts varargs parameter', () => {
      const tree = parseJava(`
        public class Formatter {
          public String format(String template, Object... args) { return ""; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);
      const params = result!.methods[0].parameters;

      expect(params).toHaveLength(2);
      expect(params[0].isVariadic).toBe(false);
      expect(params[1].isVariadic).toBe(true);
      expect(params[1].name).toBe('args');
    });

    it('extracts void return type', () => {
      const tree = parseJava(`
        public class Foo {
          public void doNothing() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods[0].returnType).toBe('void');
    });
  });

  describe('extract overloaded methods', () => {
    it('extracts all overloads without collision', () => {
      const tree = parseJava(`
        public class Repository {
          public User find(Long id) { return null; }
          public User find(String name, boolean active) { return null; }
          public User find(String name, String email, int limit) { return null; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result).not.toBeNull();
      const finds = result!.methods.filter((m) => m.name === 'find');
      expect(finds).toHaveLength(3);
      expect(finds.map((m) => m.parameters.length).sort()).toEqual([1, 2, 3]);
    });
  });

  describe('extract from abstract class', () => {
    it('detects abstract methods', () => {
      const tree = parseJava(`
        public abstract class Shape {
          public abstract double area();
          public double perimeter() { return 0; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods).toHaveLength(2);

      const areaMethod = result!.methods.find((m) => m.name === 'area');
      const perimeterMethod = result!.methods.find((m) => m.name === 'perimeter');

      expect(areaMethod!.isAbstract).toBe(true);
      expect(perimeterMethod!.isAbstract).toBe(false);
    });
  });

  describe('extract from interface', () => {
    it('marks bodyless methods as abstract', () => {
      const tree = parseJava(`
        public interface Repository {
          User findById(Long id);
          List findAll();
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods).toHaveLength(2);
      expect(result!.methods[0].isAbstract).toBe(true);
      expect(result!.methods[1].isAbstract).toBe(true);
    });

    it('marks default methods as non-abstract', () => {
      const tree = parseJava(`
        public interface Greeting {
          void greet();
          default String name() { return "World"; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      const greet = result!.methods.find((m) => m.name === 'greet');
      const name = result!.methods.find((m) => m.name === 'name');

      expect(greet!.isAbstract).toBe(true);
      expect(name!.isAbstract).toBe(false);
    });
  });

  describe('extract from enum', () => {
    it('extracts enum methods', () => {
      const tree = parseJava(`
        public enum Planet {
          EARTH;
          public double surfaceGravity() { return 9.8; }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      expect(result!.methods.length).toBeGreaterThanOrEqual(1);
      const sg = result!.methods.find((m) => m.name === 'surfaceGravity');
      expect(sg).toBeDefined();
      expect(sg!.returnType).toBe('double');
    });
  });

  describe('no methods', () => {
    it('returns null for class with no methods', () => {
      const tree = parseJava(`
        public class Empty {
          public int x;
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, javaCtx);

      // No method_declaration nodes → empty methods array
      expect(result).not.toBeNull();
      expect(result!.methods).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const describeKotlin = Kotlin ? describe : describe.skip;

describeKotlin('Kotlin MethodExtractor', () => {
  const extractor = createMethodExtractor(kotlinMethodConfig);

  describe('extract from class', () => {
    it('extracts public method with parameters', () => {
      const tree = parseKotlin(`
        class UserService {
          fun findById(id: Long, active: Boolean): User? {
            return null
          }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('UserService');
      expect(result!.methods).toHaveLength(1);

      const m = result!.methods[0];
      expect(m.name).toBe('findById');
      expect(m.visibility).toBe('public');
      expect(m.isStatic).toBe(false);
      expect(m.isAbstract).toBe(false);
      expect(m.parameters).toHaveLength(2);
    });

    it('extracts private method', () => {
      const tree = parseKotlin(`
        class Foo {
          private fun helper(): Int = 42
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      const m = result!.methods.find((m) => m.name === 'helper');
      expect(m).toBeDefined();
      expect(m!.visibility).toBe('private');
    });
  });

  describe('extract from abstract class', () => {
    it('detects abstract methods', () => {
      const tree = parseKotlin(`
        abstract class Shape {
          abstract fun area(): Double
          fun description(): String = "shape"
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      const area = result!.methods.find((m) => m.name === 'area');
      const desc = result!.methods.find((m) => m.name === 'description');

      expect(area).toBeDefined();
      expect(area!.isAbstract).toBe(true);
      expect(desc).toBeDefined();
      expect(desc!.isAbstract).toBe(false);
    });
  });

  describe('extract from interface', () => {
    it('marks bodyless methods as abstract', () => {
      const tree = parseKotlin(`
        interface Repository {
          fun findById(id: Long): Any?
          fun findAll(): List<Any>
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods).toHaveLength(2);
      for (const m of result!.methods) {
        expect(m.isAbstract).toBe(true);
      }
    });
  });

  describe('default visibility', () => {
    it('defaults to public', () => {
      const tree = parseKotlin(`
        class Foo {
          fun bar() { }
        }
      `);
      const classNode = tree.rootNode.child(0)!;
      const result = extractor.extract(classNode, kotlinCtx);

      expect(result!.methods[0].visibility).toBe('public');
    });
  });
});
