import { describe, expect, test } from 'bun:test';
import { strFromU8, unzipSync } from 'fflate';
import { artifactFilename, artifactPrompt, createArtifact, parseArtifact, serializeArtifact, workflowPrompt } from './model';
import { calculateCell, columnName } from './formulas';
import { exportCsv, exportDocx, exportPptx, exportSvg, exportXlsx } from './exports';
import { personalWorkspaceI18n } from '../i18n/messages/personal-workspace.i18n';

describe('personal workspace files', () => {
  for (const kind of ['document', 'spreadsheet', 'presentation', 'sketch'] as const) {
    test(`${kind} round-trips without losing editable content`, () => {
      const artifact = createArtifact(kind, 'Carter’s 工作');
      expect(parseArtifact(serializeArtifact(artifact))).toEqual(artifact);
    });
  }
  test('rejects malformed, oversized, unknown-version, and unsafe drawing data', () => {
    expect(() => parseArtifact('{')).toThrow();
    expect(() => parseArtifact(JSON.stringify({ version: 2, kind: 'document', title: 'test', markdown: '' }))).toThrow();
    expect(() => parseArtifact('x'.repeat(8_000_001))).toThrow();
    expect(() => parseArtifact(JSON.stringify({ ...createArtifact('sketch', 'test'), elements: [{ id: 'x', tool: 'text', points: [[1, 2]], color: 'url(javascript:alert(1))', width: 4, text: '' }] }))).toThrow();
  });
  test('file names cannot escape the destination', () => {
    expect(artifactFilename('../../test\u0000', '123')).toBe('test-123.ocwork');
  });
  test('AI workflows preserve source, do not invent connectors, and require approval', () => {
    const prompt = artifactPrompt(createArtifact('document', 'Plan'), 'Write a plan', '/project/artifacts/plan.ocwork');
    expect(prompt).toContain('Read its latest contents');
    expect(prompt).toContain('Never upload or publish');
    expect(workflowPrompt('teach', 'Monthly report')).toContain('Never control or record my real Mac');
    expect(workflowPrompt('notion', 'Find my notes')).toContain('Do not claim the Home task-board integration grants general Notion access');
  });
});

describe('bounded spreadsheet calculation', () => {
  test('column names and normal arithmetic', () => {
    expect([0, 25, 26, 49].map(columnName)).toEqual(['A', 'Z', 'AA', 'AX']);
    expect(calculateCell([['=2+3*4']], 0, 0)).toBe('14');
    expect(calculateCell([['=(2+3)*4']], 0, 0)).toBe('20');
    expect(calculateCell([['=2^3^2']], 0, 0)).toBe('512');
    expect(calculateCell([['=1.2e2/4']], 0, 0)).toBe('30');
  });
  test('references, ranges, aggregates, comparisons and lazy IF', () => {
    const rows = [['2', '=SUM(A1:A3)', '=AVERAGE(A1:A3)', '=IF(A1>0, SUM(A1:A3), 1/0)'], ['4'], ['label']];
    expect(calculateCell(rows, 0, 1)).toBe('6');
    expect(calculateCell(rows, 0, 2)).toBe('3');
    expect(calculateCell(rows, 0, 3)).toBe('6');
    expect(calculateCell([['=IF(0,1/0,9)']], 0, 0)).toBe('9');
    expect(calculateCell([['1', '2', '=COUNT(A1:B2)'], ['3', 'text']], 0, 2)).toBe('3');
    expect(calculateCell([['=MIN(4,2,7)+MAX(4,2,7)']], 0, 0)).toBe('9');
  });
  test('cycles, external formulas, invalid syntax and division by zero fail visibly', () => {
    expect(calculateCell([['=B1', '=A1']], 0, 0)).toBe('#CYCLE!');
    expect(calculateCell([['=1/0']], 0, 0)).toBe('#DIV/0!');
    expect(calculateCell([['=A501']], 0, 0)).toBe('#REF!');
    expect(calculateCell([['=SUM(A1:AX999999)']], 0, 0)).toBe('#REF!');
    expect(calculateCell([['=HYPERLINK("https://example.com")']], 0, 0)).toBe('#NAME?');
    expect(calculateCell([['=IF(1,2,WEBSERVICE(1))']], 0, 0)).toBe('#NAME?');
    expect(calculateCell([['=WEBSERVICE(1)']], 0, 0)).toBe('#NAME?');
    expect(calculateCell([['=1;globalThis.process.exit()']], 0, 0)).toBe('#FORMULA!');
    expect(calculateCell([['=' + '1+'.repeat(1001) + '1']], 0, 0)).toBe('#LIMIT!');
  });
  test('shared dependencies do not expand exponentially', () => {
    const rows = Array.from({ length: 40 }, (_, index) => [index === 39 ? '1' : `=A${index + 2}+A${index + 2}`]);
    expect(calculateCell(rows, 0, 0)).toBe('549755813888');
  });
});

describe('portable exports', () => {
  test('DOCX is a valid package with escaped Unicode content', () => {
    const bytes = exportDocx({ version: 1, kind: 'document', title: 'Plan', template: false, markdown: '# 工作 & <Plan>\nHello' });
    const parts = unzipSync(bytes);
    expect(strFromU8(parts['word/document.xml'])).toContain('工作 &amp; &lt;Plan&gt;');
    expect(strFromU8(parts['_rels/.rels'])).toContain('word/document.xml');
  });
  test('XLSX keeps supported formulas and treats unsupported executable cells as text', () => {
    const bytes = exportXlsx({ version: 1, kind: 'spreadsheet', title: 'Budget', template: false, sheets: [{ name: 'Costs', rows: [['2', '=A1*3', '=WEBSERVICE(1)', '<script>']] }] });
    const parts = unzipSync(bytes); const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<f>A1*3</f><v>6</v>');
    expect(sheet).toContain('<t xml:space="preserve">=WEBSERVICE(1)</t>');
    expect(sheet).toContain('&lt;script&gt;');
    expect(strFromU8(parts['xl/workbook.xml'])).toContain('fullCalcOnLoad="1"');
  });
  test('CSV quotes delimiters and neutralizes formula injection', () => {
    expect(exportCsv([['x,y', '"quoted"', '=2+3', '@SUM(1)', '-5', '+cmd']])).toBe('"x,y","""quoted""","5","\'@SUM(1)","-5","\'+cmd"');
  });
  test('PPTX includes every slide, relationship and speaker note', () => {
    const parts = unzipSync(exportPptx({ version: 1, kind: 'presentation', title: 'Deck', template: false, slides: [{ title: 'One', body: 'Hello & goodbye', notes: 'Private notes' }, { title: 'Two', body: '世界', notes: '' }] }));
    expect(strFromU8(parts['ppt/slides/slide1.xml'])).toContain('Hello &amp; goodbye');
    expect(strFromU8(parts['ppt/slides/slide2.xml'])).toContain('世界');
    expect(strFromU8(parts['ppt/notesSlides/notesSlide1.xml'])).toContain('Private notes');
    expect(strFromU8(parts['ppt/_rels/presentation.xml.rels'])).toContain('slides/slide2.xml');
  });
  test('SVG text cannot inject executable markup', () => {
    const source = exportSvg({ version: 1, kind: 'sketch', title: '<script>', template: false, elements: [{ id: '1', tool: 'text', text: '</text><script>alert(1)</script>', points: [[10, 20]], width: 4, color: '#111111' }] });
    expect(source).not.toContain('<script>');
    expect(source).toContain('&lt;script&gt;');
  });
});

test('every shipped locale has complete workspace messages', () => {
  const keys = Object.keys(personalWorkspaceI18n.en).sort();
  for (const dictionary of Object.values(personalWorkspaceI18n)) {
    expect(Object.keys(dictionary).sort()).toEqual(keys);
    expect(Object.values(dictionary).every((value) => value.trim().length > 0)).toBe(true);
  }
});
