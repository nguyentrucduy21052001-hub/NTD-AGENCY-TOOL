/**
 * NTD Agency - Maps Batch Query Builder
 * Tạo danh sách các truy vấn tìm kiếm bằng cách kết hợp từ khóa với tỉnh thành / phường xã.
 */

export function splitItems(text) {
  return [...new Set(String(text || '').split(/[\n;,]+/).map(x => x.trim()).filter(Boolean))];
}

export function buildQueries(keywords, mode, provinceText, wardText) {
  const keys = splitItems(keywords);
  const provinces = splitItems(provinceText);

  if (!keys.length) throw Error('Vui lòng nhập ít nhất một từ khóa tìm kiếm.');

  if (mode === 'custom') return keys;

  let areas = provinces;
  if (mode === 'ward') {
    areas = [...new Set(String(wardText || '').split(/[\n;]+/).map(x => x.trim()).filter(Boolean))];
    if (!areas.length) throw Error('Vui lòng nhập phường / xã cần tìm.');
    if (areas.some(x => !x.includes(',')) && provinces.length !== 1) {
      throw Error('Với phường/xã chưa kèm tỉnh, hãy nhập đúng một tỉnh để tránh ghép sai địa điểm.');
    }
    areas = areas.map(x => (x.includes(',') ? x : x + ', ' + provinces[0]));
  }

  if (!areas.length) throw Error('Vui lòng nhập tỉnh / thành phố cần tìm.');

  return [...new Set(keys.flatMap(k => areas.map(a => k + ' ' + a)))];
}

if (typeof window !== 'undefined') {
  window.splitItems = splitItems;
  window.buildQueries = buildQueries;
}
