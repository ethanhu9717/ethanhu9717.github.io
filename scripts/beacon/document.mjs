import { parseDocument } from 'yaml';

export function splitDocument(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const yaml = match ? parseDocument(match[1]) : parseDocument('{}');
  if (!match && yaml.contents) yaml.contents.flow = false;
  return {
    raw,
    header: match?.[0] ?? '',
    body: match ? raw.slice(match[0].length) : raw,
    yaml,
    error: yaml.errors.map((error) => error.message).join('\n'),
  };
}
export function metadata(raw) {
  const document = splitDocument(raw);
  if (document.error) return {};
  const value = document.yaml.toJSON();
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
export function replaceBody(raw, body) {
  return splitDocument(raw).header + body;
}
export function updateMetadata(raw, changes) {
  const document = splitDocument(raw);
  if (document.error) throw new Error(`文章信息格式错误，请在原文模式修正：${document.error}`);
  for (const [key, value] of Object.entries(changes)) document.yaml.set(key, value);
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  return `---${newline}${String(document.yaml).replace(/\r?\n/g, newline)}---${newline}${document.body}`;
}
export function previewLines(raw) {
  const { body } = splitDocument(raw);
  const title = metadata(raw).title || '未命名文章';
  let fence = false;
  return [
    String(title),
    '',
    ...body.split(/\r?\n/).map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        return fence ? `[代码 ${line.trim().slice(3)}]` : '[代码结束]';
      }
      if (fence) return `  ${line}`;
      return line
        .replace(/^>\s?/, '│ ')
        .replace(/^#{1,6}\s+/, '')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片：$1 · $2]')
        .replace(/!\[\[([^\]]+)\]\]/g, '[图片：$1]')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
        .replace(/(\*\*|__)(.*?)\1/g, '$2');
    }),
  ];
}
