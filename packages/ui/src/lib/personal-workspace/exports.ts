import { strToU8, zipSync } from 'fflate';
import { calculateCell, columnName } from './formulas';
import type { SketchElement, WorkspaceArtifact } from './model';
import { penPathD } from './sketch';

const withoutControls = (value: string, keepWhitespace = false) => [...value].filter((char) => char.charCodeAt(0) >= 32 || (keepWhitespace && ['\t', '\n', '\r'].includes(char))).join('');
const xml = (value: string) => withoutControls(value, true).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const packageZip = (parts: Iterable<[string, string]>) => zipSync(Object.fromEntries([...parts].map(([path, value]) => [path, strToU8(declaration + value)])));
const relationships = (items: { id: string; type: string; target: string }[]) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((item) => `<Relationship Id="${xml(item.id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${item.type}" Target="${xml(item.target)}"/>`).join('')}</Relationships>`;
const contentTypes = (overrides: { path: string; type: string }[]) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map((part) => `<Override PartName="/${part.path}" ContentType="application/vnd.openxmlformats-officedocument.${part.type}"/>`).join('')}</Types>`;
export const artifactStem = (title: string) => withoutControls(title).replace(/[/\\:*?"<>|]/g, '-').slice(0, 120) || 'artifact';
export function downloadArtifact(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  // The browser consumes downloads asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function exportDocx(artifact: Extract<WorkspaceArtifact, { kind: 'document' }>): Uint8Array<ArrayBuffer> {
  const paragraphs = artifact.markdown.split('\n').map((line) => {
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    const content = heading ? heading[2] : line;
    const size = heading ? Math.max(24, 40 - heading[1].length * 4) : 22;
    return `<w:p><w:pPr><w:spacing w:after="120"/>${heading ? '<w:keepNext/>' : ''}</w:pPr><w:r><w:rPr><w:sz w:val="${size}"/>${heading ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(content)}</w:t></w:r></w:p>`;
  }).join('');
  return packageZip(Object.entries({
    '[Content_Types].xml': contentTypes([{ path: 'word/document.xml', type: 'wordprocessingml.document.main+xml' }]),
    '_rels/.rels': relationships([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
  }));
}

export function exportCsv(rows: string[][]): string {
  // Preserve formulas in XLSX, but neutralize executable spreadsheet cells in CSV.
  return rows.map((row, rowIndex) => row.map((value, column) => {
    const calculated = value.startsWith('=') ? calculateCell(rows, rowIndex, column) : value;
    const safe = /^\s*[=+@]|^\s*-(?!\d)/.test(calculated) ? `'${calculated}` : calculated;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n');
}

export function exportXlsx(artifact: Extract<WorkspaceArtifact, { kind: 'spreadsheet' }>): Uint8Array<ArrayBuffer> {
  const parts = new Map(Object.entries({
    '[Content_Types].xml': contentTypes([{ path: 'xl/workbook.xml', type: 'spreadsheetml.sheet.main+xml' }, ...artifact.sheets.map((_, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, type: 'spreadsheetml.worksheet+xml' }))]),
    '_rels/.rels': relationships([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]),
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${artifact.sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships(artifact.sheets.map((_, i) => ({ id: `rId${i + 1}`, type: 'worksheet', target: `worksheets/sheet${i + 1}.xml` }))),
  }));
  artifact.sheets.forEach((sheet, i) => {
    parts.set(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
      const address = `${columnName(c)}${r + 1}`;
      if (value.startsWith('=')) {
        const computed = calculateCell(sheet.rows, r, c);
        // Export only our supported expression language. No DDE, URL, macro, or external-workbook formulas.
        if (computed.startsWith('#')) return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        return `<c r="${address}"><f>${xml(value.slice(1))}</f><v>${xml(computed)}</v></c>`;
      }
      if (value.trim() && Number.isFinite(Number(value))) return `<c r="${address}"><v>${Number(value)}</v></c>`;
      return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('')}</row>`).join('')}</sheetData></worksheet>`);
  });
  return packageZip(parts);
}

const drawingNs = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const groupTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const slideTextBox = (id: number, name: string, content: string, y: number, height: number, size: number) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="${y}"/><a:ext cx="10820400" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${content.split('\n').map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="${size}"/><a:t>${xml(line)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`).join('')}</p:txBody></p:sp>`;

export function exportPptx(artifact: Extract<WorkspaceArtifact, { kind: 'presentation' }>): Uint8Array<ArrayBuffer> {
  const overrides = [
    { path: 'ppt/presentation.xml', type: 'presentationml.presentation.main+xml' },
    { path: 'ppt/slideMasters/slideMaster1.xml', type: 'presentationml.slideMaster+xml' },
    { path: 'ppt/slideLayouts/slideLayout1.xml', type: 'presentationml.slideLayout+xml' },
    { path: 'ppt/notesMasters/notesMaster1.xml', type: 'presentationml.notesMaster+xml' },
    ...artifact.slides.flatMap((_, i) => [{ path: `ppt/slides/slide${i + 1}.xml`, type: 'presentationml.slide+xml' }, { path: `ppt/notesSlides/notesSlide${i + 1}.xml`, type: 'presentationml.notesSlide+xml' }]),
  ];
  const parts = new Map(Object.entries({
    '[Content_Types].xml': contentTypes(overrides),
    '_rels/.rels': relationships([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]),
    'ppt/presentation.xml': `<p:presentation ${drawingNs}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="notes"/></p:notesMasterIdLst><p:sldIdLst>${artifact.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="slide${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships([{ id: 'master', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }, { id: 'notes', type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' }, ...artifact.slides.map((_, i) => ({ id: `slide${i + 1}`, type: 'slide', target: `slides/slide${i + 1}.xml` }))]),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${drawingNs}><p:cSld><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="layout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationships([{ id: 'layout', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${drawingNs} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationships([{ id: 'master', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]),
    'ppt/notesMasters/notesMaster1.xml': `<p:notesMaster ${drawingNs}><p:cSld><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:notesStyle/></p:notesMaster>`,
  }));
  artifact.slides.forEach((slide, i) => {
    parts.set(`ppt/slides/slide${i + 1}.xml`, `<p:sld ${drawingNs}><p:cSld><p:spTree>${groupTree}${slideTextBox(2, 'Title', slide.title, 457200, 1100000, 3200)}${slideTextBox(3, 'Body', slide.body, 1828800, 4343400, 2000)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    parts.set(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relationships([{ id: 'layout', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }, { id: 'notes', type: 'notesSlide', target: `../notesSlides/notesSlide${i + 1}.xml` }]));
    parts.set(`ppt/notesSlides/notesSlide${i + 1}.xml`, `<p:notes ${drawingNs}><p:cSld><p:spTree>${groupTree}${slideTextBox(2, 'Notes', slide.notes, 457200, 7000000, 1200)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
    parts.set(`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, relationships([{ id: 'master', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' }, { id: 'slide', type: 'slide', target: `../slides/slide${i + 1}.xml` }]));
  });
  return packageZip(parts);
}

export function sketchElementSvg(element: SketchElement): string {
  const [startX, startY] = element.points[0]; const [endX, endY] = element.points.at(-1) ?? element.points[0];
  const style = `stroke="${element.color}" stroke-width="${element.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  if (element.tool === 'text') return `<text x="${startX}" y="${startY}" fill="${element.color}" font-family="sans-serif" font-size="${element.width * 5 + 12}">${xml(element.text)}</text>`;
  if (element.tool === 'rectangle') return `<rect x="${Math.min(startX, endX)}" y="${Math.min(startY, endY)}" width="${Math.abs(endX - startX)}" height="${Math.abs(endY - startY)}" ${style}/>`;
  if (element.tool === 'ellipse') return `<ellipse cx="${(startX + endX) / 2}" cy="${(startY + endY) / 2}" rx="${Math.abs(endX - startX) / 2}" ry="${Math.abs(endY - startY) / 2}" ${style}/>`;
  // A tap is ink too: a zero-length path paints nothing, which reads as a dead
  // canvas, so a single point becomes a filled dot of the stroke's diameter.
  if (element.points.length === 1) return `<circle cx="${startX}" cy="${startY}" r="${element.width / 2}" fill="${element.color}"/>`;
  // Pens are smoothed through their points. Lines keep their exact polyline;
  // imported sources may carry more than the two points the tool produces.
  const d = element.tool === 'pen' ? penPathD(element.points) : element.points.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ');
  return `<path d="${d ?? ''}" ${style}/>`;
}
/**
 * The sketch paper is document content, not interface theme. Open Carter draws on
 * dark grey with a white default marker, matching the ChatGPT canvas, so the
 * on-screen drawing and the attached PNG/SVG are the same image. Change this in
 * one place: the canvas surface, the SVG export and the PNG raster all read it.
 */
export const SKETCH_PAPER = '#2f2f2f';

export const exportSvg = (artifact: Extract<WorkspaceArtifact, { kind: 'sketch' }>) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 650" width="1000" height="650"><title>${xml(artifact.title)}</title><rect width="1000" height="650" fill="${SKETCH_PAPER}"/>${artifact.elements.map(sketchElementSvg).join('')}</svg>`;
export async function sketchPng(artifact: Extract<WorkspaceArtifact, { kind: 'sketch' }>): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([exportSvg(artifact)], { type: 'image/svg+xml' }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 2000; canvas.height = 1300;
    const context = canvas.getContext('2d'); if (!context) throw new Error('canvas_unavailable');
    context.drawImage(image, 0, 0, 2000, 1300);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('png_failed')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
