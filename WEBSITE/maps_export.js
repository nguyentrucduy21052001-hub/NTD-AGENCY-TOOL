/**
 * NTD Agency - Minimal OOXML (.xlsx) Workbook Generator
 * Xuất file Excel chuẩn không cần thư viện ngoài. Sử dụng inline strings để bảo toàn số 0 ở đầu số điện thoại.
 */

export function makeXlsx(rows) {
  const enc = new TextEncoder();
  const xml = s =>
    String(s ?? '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const col = n => {
    let s = '';
    for (n++; n; n = Math.floor((n - 1) / 26)) {
      s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    }
    return s;
  };

  const files = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="NTD Maps" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      rows
        .map(
          (r, i) =>
            '<row r="' +
            (i + 1) +
            '">' +
            r
              .map(
                (v, j) =>
                  '<c r="' +
                  col(j) +
                  (i + 1) +
                  '" t="inlineStr"><is><t xml:space="preserve">' +
                  xml(v) +
                  '</t></is></c>'
              )
              .join('') +
            '</row>'
        )
        .join('') +
      '</sheetData></worksheet>'
  };

  const crc = b => {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };

  const parts = [];
  const central = [];
  let offset = 0;
  let cs = 0;

  for (const [name, content] of Object.entries(files)) {
    const n = enc.encode(name);
    const b = enc.encode(content);
    const c = crc(b);

    const h = new Uint8Array(30 + n.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint32(14, c, true);
    v.setUint32(18, b.length, true);
    v.setUint32(22, b.length, true);
    v.setUint16(26, n.length, true);
    h.set(n, 30);

    const d = new Uint8Array(46 + n.length);
    const w = new DataView(d.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(4, 20, true);
    w.setUint16(6, 20, true);
    w.setUint32(16, c, true);
    w.setUint32(20, b.length, true);
    w.setUint32(24, b.length, true);
    w.setUint16(28, n.length, true);
    w.setUint32(42, offset, true);
    d.set(n, 46);

    parts.push(h, b);
    central.push(d);
    offset += h.length + b.length;
    cs += d.length;
  }

  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, central.length, true);
  v.setUint16(10, central.length, true);
  v.setUint32(12, cs, true);
  v.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

export function downloadXlsx(name, rows) {
  const u = URL.createObjectURL(makeXlsx(rows));
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
}

if (typeof window !== 'undefined') {
  window.makeXlsx = makeXlsx;
  window.downloadXlsx = downloadXlsx;
}
