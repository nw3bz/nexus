/**
 * COBOL: PROGRAM-ID modules, paragraph functions, data items, COPY imports,
 *        CALL cross-program resolution, EXEC SQL/CICS blocks, MOVE data flow,
 *        file declarations, JCL job/step integration
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

describe('COBOL full system extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cobol-app'),
      () => {},
      { skipGraphPhases: true }, // COBOL is regex-based, not in SupportedLanguages enum
    );
  }, 60000);

  // ── Node detection ──────────────────────────────────────────────────

  it('detects Module nodes for each PROGRAM-ID', () => {
    const modules = getNodesByLabel(result, 'Module');
    expect(modules).toContain('CUSTUPDT');
    expect(modules).toContain('AUDITLOG');
    expect(modules).toContain('RPTGEN');
  });

  it('detects Function nodes for paragraphs', () => {
    const funcs = getNodesByLabel(result, 'Function');
    // CUSTUPDT paragraphs
    expect(funcs).toContain('MAIN-PARAGRAPH');
    expect(funcs).toContain('INIT-PARAGRAPH');
    expect(funcs).toContain('PROCESS-PARAGRAPH');
    expect(funcs).toContain('READ-CUSTOMER');
    expect(funcs).toContain('UPDATE-BALANCE');
    expect(funcs).toContain('WRITE-CUSTOMER');
    expect(funcs).toContain('CLEANUP-PARAGRAPH');
    // AUDITLOG paragraphs
    expect(funcs).toContain('WRITE-LOG');
    // RPTGEN paragraphs
    expect(funcs).toContain('FETCH-DATA');
    expect(funcs).toContain('FORMAT-REPORT');
    expect(funcs).toContain('SEND-SCREEN');
  });

  it('detects Property nodes for data items', () => {
    const props = getNodesByLabel(result, 'Property');
    // CUSTUPDT data items
    expect(props).toContain('WS-FILE-STATUS');
    expect(props).toContain('WS-CUSTOMER-NAME');
    expect(props).toContain('WS-AMOUNT');
    expect(props).toContain('CUST-ID');
    expect(props).toContain('CUST-NAME');
    expect(props).toContain('CUST-BALANCE');
    // AUDITLOG data items
    expect(props).toContain('WS-LOG-MESSAGE');
    expect(props).toContain('WS-TIMESTAMP');
    expect(props).toContain('LS-CUST-ID');
    expect(props).toContain('LS-AMOUNT');
    // RPTGEN data items (from COPY expansion)
    expect(props).toContain('WS-REPORT-LINE');
    expect(props).toContain('WS-SQL-CODE');
  });

  it('detects Record nodes for file declarations', () => {
    const records = getNodesByLabel(result, 'Record');
    expect(records).toContain('CUSTOMER-FILE');
  });

  it('detects CodeElement nodes for EXEC SQL blocks', () => {
    const codeElements = getNodesByLabel(result, 'CodeElement');
    const sqlElements = codeElements.filter(n => n.startsWith('EXEC SQL'));
    expect(sqlElements.length).toBe(1);
    expect(sqlElements.some(n => n.includes('SELECT'))).toBe(true);
  });

  it('detects CodeElement nodes for EXEC CICS blocks', () => {
    const codeElements = getNodesByLabel(result, 'CodeElement');
    const cicsElements = codeElements.filter(n => n.startsWith('EXEC CICS'));
    expect(cicsElements.length).toBe(2);
    expect(cicsElements.some(n => n.includes('SEND'))).toBe(true);
    expect(cicsElements.some(n => n.includes('LINK'))).toBe(true);
  });

  // ── Intra-program relationships ─────────────────────────────────────

  it('emits CALLS edges for PERFORM statements', () => {
    const calls = getRelationships(result, 'CALLS');
    const performs = calls.filter(e => e.rel.reason === 'cobol-perform');
    // CUSTUPDT: MAIN performs INIT, PROCESS, CLEANUP
    expect(performs.some(e => e.target === 'INIT-PARAGRAPH')).toBe(true);
    expect(performs.some(e => e.target === 'PROCESS-PARAGRAPH')).toBe(true);
    expect(performs.some(e => e.target === 'CLEANUP-PARAGRAPH')).toBe(true);
    // PROCESS performs READ-CUSTOMER, UPDATE-BALANCE, WRITE-CUSTOMER
    expect(performs.some(e => e.target === 'READ-CUSTOMER')).toBe(true);
    expect(performs.some(e => e.target === 'UPDATE-BALANCE')).toBe(true);
    expect(performs.some(e => e.target === 'WRITE-CUSTOMER')).toBe(true);
  });

  it('emits CALLS edges for PERFORM THRU ranges', () => {
    const calls = getRelationships(result, 'CALLS');
    const thrus = calls.filter(e => e.rel.reason === 'cobol-perform-thru');
    // RPTGEN: PERFORM MAIN-PARAGRAPH THRU FORMAT-REPORT
    expect(thrus.some(e => e.target === 'FORMAT-REPORT')).toBe(true);
  });

  it('emits CONTAINS edges for module->paragraph hierarchy', () => {
    const contains = getRelationships(result, 'CONTAINS');
    // CUSTUPDT module contains its paragraphs
    const custContains = contains.filter(e =>
      e.source === 'CUSTUPDT' && e.rel.reason === 'cobol-paragraph',
    );
    const custTargets = custContains.map(e => e.target);
    expect(custTargets).toContain('MAIN-PARAGRAPH');
    expect(custTargets).toContain('INIT-PARAGRAPH');
    expect(custTargets).toContain('PROCESS-PARAGRAPH');
  });

  it('emits ACCESSES edges for MOVE statements (read/write)', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const moveReads = accesses.filter(e =>
      e.rel.reason === 'cobol-move-read',
    );
    const moveWrites = accesses.filter(e =>
      e.rel.reason === 'cobol-move-write',
    );
    expect(moveReads.length).toBe(3);
    expect(moveWrites.length).toBe(3);
  });

  // ── Cross-program relationships ─────────────────────────────────────

  it('resolves CALL to known program as CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const cobolCalls = calls.filter(e => e.rel.reason === 'cobol-call');
    expect(cobolCalls.length).toBe(2);
  });

  it('emits CALLS with reason cobol-call for static CALL', () => {
    const calls = getRelationships(result, 'CALLS');
    // CUSTUPDT calls AUDITLOG
    const custToAudit = calls.filter(e =>
      e.source === 'CUSTUPDT' && e.target === 'AUDITLOG' && e.rel.reason === 'cobol-call',
    );
    expect(custToAudit.length).toBe(1);
  });

  it('emits CALLS for EXEC CICS LINK with programName', () => {
    const calls = getRelationships(result, 'CALLS');
    const cicsLinks = calls.filter(e => e.rel.reason === 'cics-link');
    expect(cicsLinks.length).toBe(1);
    // RPTGEN EXEC CICS LINK PROGRAM('AUDITLOG') — resolved in second pass
    const link = cicsLinks.find(e => e.source === 'RPTGEN');
    expect(link).toBeDefined();
    expect(link!.target).toBe('AUDITLOG');
  });

  it('resolves CALL AUDITLOG from both CUSTUPDT and RPTGEN', () => {
    const calls = getRelationships(result, 'CALLS');
    // CUSTUPDT -> AUDITLOG via CALL (resolved in second pass)
    const custToAudit = calls.filter(e =>
      e.source === 'CUSTUPDT' && e.target === 'AUDITLOG',
    );
    expect(custToAudit.length).toBe(1);
    // RPTGEN -> AUDITLOG via EXEC CICS LINK (resolved in second pass)
    const rptToAudit = calls.filter(e =>
      e.source === 'RPTGEN' && e.target === 'AUDITLOG',
    );
    expect(rptToAudit.length).toBe(1);
  });

  // ── COPY/import resolution ──────────────────────────────────────────

  it('emits IMPORTS edge for COPY statement', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const cobolCopies = imports.filter(e => e.rel.reason === 'cobol-copy');
    expect(cobolCopies.length).toBe(1);
  });

  it('RPTGEN imports CUSTDAT copybook', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const rptImports = imports.filter(e =>
      e.sourceFilePath.includes('RPTGEN') && e.targetFilePath.includes('CUSTDAT'),
    );
    expect(rptImports.length).toBe(1);
    expect(rptImports[0].rel.reason).toBe('cobol-copy');
  });

  // ── EXEC SQL ────────────────────────────────────────────────────────

  it('creates CodeElement for EXEC SQL SELECT', () => {
    const codeElements = getNodesByLabel(result, 'CodeElement');
    expect(codeElements).toContain('EXEC SQL SELECT');
  });

  it('creates ACCESSES edge to CUSTOMER table', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    // The SQL ACCESSES edge targets a synthetic Record node (<db>:CUSTOMER)
    // which is not added to the graph, so we verify by reason and source
    const sqlAccesses = accesses.filter(e =>
      e.rel.reason === 'sql-select' && e.source === 'EXEC SQL SELECT',
    );
    expect(sqlAccesses.length).toBe(1);
  });

  // ── EXEC CICS ───────────────────────────────────────────────────────

  it('creates CodeElement for EXEC CICS SEND MAP', () => {
    const codeElements = getNodesByLabel(result, 'CodeElement');
    // Two-word CICS command: SEND MAP is recognized as a single command
    expect(codeElements).toContain('EXEC CICS SEND MAP');
  });

  it('creates CodeElement for EXEC CICS LINK', () => {
    const codeElements = getNodesByLabel(result, 'CodeElement');
    expect(codeElements).toContain('EXEC CICS LINK');
  });

  // ── Data flow ───────────────────────────────────────────────────────

  it('tracks MOVE from WS-AMOUNT to CUST-BALANCE as ACCESSES', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writeToBalance = accesses.filter(e =>
      e.target === 'CUST-BALANCE' && e.rel.reason === 'cobol-move-write',
    );
    expect(writeToBalance.length).toBe(1);
  });

  it('tracks MOVE from CUST-NAME to WS-CUSTOMER-NAME as ACCESSES', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const readFromName = accesses.filter(e =>
      e.target === 'CUST-NAME' && e.rel.reason === 'cobol-move-read',
    );
    const writeToWsName = accesses.filter(e =>
      e.target === 'WS-CUSTOMER-NAME' && e.rel.reason === 'cobol-move-write',
    );
    expect(readFromName.length).toBe(1);
    expect(writeToWsName.length).toBe(1);
  });

  // ── JCL integration ─────────────────────────────────────────────────

  it('creates CodeElement for JCL job steps', () => {
    const codeElements = getNodesByLabel(result, 'CodeElement');
    // JCL job node
    expect(codeElements).toContain('CUSTJOB');
    // JCL step nodes
    expect(codeElements).toContain('STEP1');
    expect(codeElements).toContain('STEP2');
  });

  it('links JCL EXEC PGM=CUSTUPDT to COBOL Module', () => {
    const calls = getRelationships(result, 'CALLS');
    const step1ToCust = calls.filter(e =>
      e.source === 'STEP1' && e.target === 'CUSTUPDT' && e.rel.reason === 'jcl-exec-pgm',
    );
    expect(step1ToCust.length).toBe(1);
  });

  it('links JCL EXEC PGM=RPTGEN to COBOL Module', () => {
    const calls = getRelationships(result, 'CALLS');
    const step2ToRpt = calls.filter(e =>
      e.source === 'STEP2' && e.target === 'RPTGEN' && e.rel.reason === 'jcl-exec-pgm',
    );
    expect(step2ToRpt.length).toBe(1);
  });

  it('JCL step CALLS COBOL program', () => {
    const calls = getRelationships(result, 'CALLS');
    const jclCalls = calls.filter(e => e.rel.reason === 'jcl-exec-pgm');
    expect(jclCalls.length).toBe(2);
    const targets = jclCalls.map(e => e.target).sort();
    expect(targets).toEqual(['CUSTUPDT', 'RPTGEN']);
  });
});
