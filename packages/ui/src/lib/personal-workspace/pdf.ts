import { calculateCell } from './formulas';
import { sketchPng } from './exports';
import type { WorkspaceArtifact } from './model';

/** Local raster PDF. Browser fonts retain Unicode; no content leaves the runtime. */
export async function exportPdf(artifact: WorkspaceArtifact): Promise<Blob> {
  const pages: { bytes: Uint8Array; width: number; height: number }[] = [];
  const canvas = document.createElement('canvas'); canvas.width = 1240; canvas.height = 1754;
  const context = canvas.getContext('2d'); if (!context) throw new Error('canvas_unavailable');
  const savePage = () => {
    if (pages.length >= 200) throw new Error('pdf_page_limit');
    const encoded = atob(canvas.toDataURL('image/jpeg', 0.94).split(',')[1]);
    pages.push({ bytes: Uint8Array.from(encoded, (char) => char.charCodeAt(0)), width: canvas.width, height: canvas.height });
  };
  const reset = () => {
    // Paper colors are output content, independent of the app theme.
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black'; context.font = '26px sans-serif'; context.textBaseline = 'top';
  };
  let y = 90;
  const write = (source: string, size = 26) => {
    context.font = `${size}px sans-serif`;
    let line = '';
    for (const char of source) {
      if (context.measureText(line + char).width > canvas.width - 180 && line) {
        if (y + size * 1.5 > canvas.height - 90) { savePage(); reset(); context.font = `${size}px sans-serif`; y = 90; }
        context.fillText(line, 90, y); y += size * 1.5; line = '';
      }
      line += char;
    }
    if (y + size * 1.5 > canvas.height - 90) { savePage(); reset(); context.font = `${size}px sans-serif`; y = 90; }
    context.fillText(line, 90, y); y += size * 1.5;
  };
  reset();
  if (artifact.kind === 'sketch') {
    canvas.width = 2000; canvas.height = 1300; reset();
    const bitmap = await createImageBitmap(await sketchPng(artifact));
    context.drawImage(bitmap, 0, 0); bitmap.close(); savePage();
  } else if (artifact.kind === 'presentation') {
    canvas.width = 1600; canvas.height = 900;
    for (const slide of artifact.slides) {
      reset(); y = 80; write(slide.title, 48); y += 24;
      for (const line of slide.body.split('\n')) write(line, 28);
      savePage();
    }
  } else if (artifact.kind === 'spreadsheet') {
    for (const sheet of artifact.sheets) {
      reset(); y = 90; write(`${artifact.title} · ${sheet.name}`, 36); y += 20;
      for (let row = 0; row < sheet.rows.length; row++) {
        write(sheet.rows[row].map((_, column) => calculateCell(sheet.rows, row, column)).join('  |  '), 22);
      }
      savePage();
    }
  } else {
    write(artifact.title, 40); y += 20;
    for (const line of artifact.markdown.split('\n')) {
      const heading = /^(#{1,6})\s+(.*)/.exec(line);
      write(heading ? heading[2] : line, heading ? Math.max(28, 42 - heading[1].length * 2) : 26);
    }
    savePage();
  }
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = []; const offsets = [0]; let length = 0;
  const appendBytes = (bytes: Uint8Array) => { chunks.push(bytes); length += bytes.length; };
  const append = (value: string) => appendBytes(encoder.encode(value));
  const object = (id: number, body: string) => { offsets[id] = length; append(`${id} 0 obj\n${body}\nendobj\n`); };
  append('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`);
  pages.forEach((page, i) => {
    const id = 3 + i * 3; const width = page.width / 2; const height = page.height / 2;
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    offsets[id + 1] = length;
    append(`${id + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);
    appendBytes(page.bytes); append('\nendstream\nendobj\n');
    const commands = `q ${width} 0 0 ${height} 0 0 cm /Im Do Q`;
    object(id + 2, `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
  });
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks.map((chunk) => new Uint8Array(chunk)), { type: 'application/pdf' });
}
