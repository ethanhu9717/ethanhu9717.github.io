import stringWidth from 'string-width';
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export const graphemes = (text) => Array.from(segmenter.segment(text), (item) => item.segment);
export const width = (text) => stringWidth(text);
export function clip(text, columns) {
  let result = '';
  for (const character of graphemes(String(text))) {
    if (width(result + character) > columns) break;
    result += character;
  }
  return result;
}
export function wrap(text, columns) {
  const result = [];
  let line = '';
  for (const character of graphemes(text)) {
    if (line && width(line + character) > columns) {
      result.push(line);
      line = '';
    }
    line += character;
  }
  result.push(line);
  return result;
}
export class Buffer {
  constructor(text = '') {
    this.text = text.replace(/\r\n/g, '\n');
    this.cursor = 0;
    this.history = [];
    this.future = [];
    this.lastEdit = 0;
  }
  snapshot() {
    return { text: this.text, cursor: this.cursor };
  }
  edit(text, cursor, group = false) {
    if (text === this.text) return;
    const now = Date.now();
    if (!group || now - this.lastEdit > 500 || !this.history.length)
      this.history.push(this.snapshot());
    this.history = this.history.slice(-200);
    this.future = [];
    this.text = text;
    this.cursor = cursor;
    this.lastEdit = group ? now : 0;
  }
  insert(value, group = false) {
    value = value.replace(/\r\n?/g, '\n');
    this.edit(
      this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor),
      this.cursor + value.length,
      group,
    );
  }
  left() {
    this.lastEdit = 0;
    this.cursor -= graphemes(this.text.slice(0, this.cursor)).at(-1)?.length ?? 0;
  }
  right() {
    this.lastEdit = 0;
    this.cursor += graphemes(this.text.slice(this.cursor))[0]?.length ?? 0;
  }
  backspace() {
    const start = this.cursor - (graphemes(this.text.slice(0, this.cursor)).at(-1)?.length ?? 0);
    this.edit(this.text.slice(0, start) + this.text.slice(this.cursor), start);
  }
  delete() {
    const end = this.cursor + (graphemes(this.text.slice(this.cursor))[0]?.length ?? 0);
    this.edit(this.text.slice(0, this.cursor) + this.text.slice(end), this.cursor);
  }
  undo() {
    const value = this.history.pop();
    if (value) {
      this.future.push(this.snapshot());
      Object.assign(this, value);
    }
    this.lastEdit = 0;
  }
  redo() {
    const value = this.future.pop();
    if (value) {
      this.history.push(this.snapshot());
      Object.assign(this, value);
    }
    this.lastEdit = 0;
  }
  find(query, direction = 1) {
    if (!query) return false;
    let position =
      direction > 0
        ? this.text.indexOf(query, this.cursor + 1)
        : this.text.lastIndexOf(query, this.cursor - 1);
    if (direction < 0 && this.cursor === 0) position = -1;
    if (position < 0)
      position = direction > 0 ? this.text.indexOf(query) : this.text.lastIndexOf(query);
    if (position < 0) return false;
    this.cursor = position;
    this.lastEdit = 0;
    return true;
  }
  layout(columns) {
    const rows = [];
    let offset = 0;
    let lineNumber = 0;
    for (const line of this.text.split('\n')) {
      lineNumber++;
      let start = offset;
      let text = '';
      for (const char of graphemes(line)) {
        if (text && width(text + char) > columns) {
          rows.push({ text, start, end: offset, lineNumber });
          text = '';
          start = offset;
        }
        text += char;
        offset += char.length;
      }
      rows.push({ text, start, end: offset, lineNumber });
      offset += 1;
    }
    return rows;
  }
  rowIndex(rows) {
    return rows.findIndex(
      (row, index) =>
        this.cursor >= row.start && (this.cursor < row.end || rows[index + 1]?.start !== row.end),
    );
  }
  vertical(delta, columns) {
    const rows = this.layout(columns);
    const index = this.rowIndex(rows);
    const column = width(this.text.slice(rows[index].start, this.cursor));
    const row = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
    let offset = row.start;
    let used = 0;
    for (const char of graphemes(row.text)) {
      if (used + width(char) > column) break;
      used += width(char);
      offset += char.length;
    }
    this.cursor = offset;
    this.lastEdit = 0;
  }
  boundary(end = false) {
    this.cursor = end
      ? (this.text.indexOf('\n', this.cursor) + 1 || this.text.length + 1) - 1
      : this.cursor === 0
        ? 0
        : this.text.lastIndexOf('\n', this.cursor - 1) + 1;
    this.lastEdit = 0;
  }
}
