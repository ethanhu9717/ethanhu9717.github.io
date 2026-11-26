// 关键字使用粗体，注释使用斜体，在两套灰阶主题中都能分清语法层级。
function createTheme(name, type, colors) {
  return {
    name,
    type,
    colors: {
      'editor.background': colors.background,
      'editor.foreground': colors.default,
    },
    tokenColors: [
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: colors.comment, fontStyle: 'italic' },
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'storage.modifier',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'variable.language',
        ],
        settings: { foreground: colors.keyword, fontStyle: 'bold' },
      },
      {
        scope: ['string', 'punctuation.definition.string', 'string.template'],
        settings: { foreground: colors.string },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
        settings: { foreground: colors.number },
      },
      {
        scope: ['entity.name.tag', 'entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key'],
        settings: { foreground: colors.tag },
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'entity.name.type',
          'entity.name.class',
          'support.class',
          'support.type',
          'markup.heading',
        ],
        settings: { foreground: colors.definition },
      },
      {
        scope: ['variable.parameter', 'variable.other.property', 'variable.other.object.property', 'markup.inline.raw'],
        settings: { foreground: colors.variable },
      },
      {
        scope: ['variable', 'keyword.operator', 'punctuation', 'meta.brace'],
        settings: { foreground: colors.default },
      },
    ],
  };
}

export const monoLight = createTheme('mono-light', 'light', {
  background: '#f7f7f7',
  comment: '#696969',
  keyword: '#161616',
  string: '#555555',
  number: '#474747',
  tag: '#383838',
  default: '#303030',
  definition: '#202020',
  variable: '#454545',
});

export const monoDark = createTheme('mono-dark', 'dark', {
  background: '#1c1c1c',
  comment: '#a3a3a3',
  keyword: '#f4f4f4',
  string: '#bdbdbd',
  number: '#c7c7c7',
  tag: '#dedede',
  default: '#d6d6d6',
  definition: '#eaeaea',
  variable: '#cccccc',
});
