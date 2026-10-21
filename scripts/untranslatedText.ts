// The guard against new untranslated UI text (scripts/untranslatedText.test.ts).
// Uses the TypeScript compiler API to find, in .tsx files:
// - JSX text containing letters
// - string literals in aria-label / placeholder / title / alt attributes
// - string literals passed to toast(...) / toast.*(...)
// Allowed: the brand "MinimaSpend", the currency codes, emoji, digits and
// punctuation (anything without a letter once those words are removed).

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'

export interface UntranslatedText {
  file: string
  line: number
  kind: 'jsx-text' | 'attribute' | 'toast'
  text: string
}

const CHECKED_ATTRIBUTES = new Set(['aria-label', 'placeholder', 'title', 'alt'])
const ALLOWED_WORDS = /\b(?:MinimaSpend|UAH|USD|EUR)\b/g
// HTML entities in JSX text (&copy;, &nbsp;, &#8212;) are symbols, not words.
const HTML_ENTITY = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g
const LETTER = /\p{L}/u

function hasUntranslatedLetters(text: string): boolean {
  return LETTER.test(text.replace(HTML_ENTITY, '').replace(ALLOWED_WORDS, ''))
}

// The literal texts an expression can evaluate to, looking through
// parentheses, both branches of ?: and the right side of ?? / ||.
function literalTexts(node: ts.Expression): Array<string> {
  if (ts.isParenthesizedExpression(node)) return literalTexts(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text]
  }
  if (ts.isTemplateExpression(node)) {
    return [[node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')]
  }
  if (ts.isConditionalExpression(node)) {
    return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)]
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return literalTexts(node.right)
  }
  return []
}

function isToastCall(node: ts.CallExpression): boolean {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'toast'
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'toast'
  )
}

export function findUntranslatedText(
  sourceText: string,
  fileName = 'inline.tsx',
): Array<UntranslatedText> {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const found: Array<UntranslatedText> = []
  const report = (node: ts.Node, kind: UntranslatedText['kind'], text: string) => {
    // JSX text starts with its leading whitespace; report the line of the words.
    const leading = kind === 'jsx-text' ? text.length - text.trimStart().length : 0
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source) + leading)
    found.push({ file: fileName, line: line + 1, kind, text })
  }

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (hasUntranslatedLetters(node.text)) report(node, 'jsx-text', node.text)
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      const value = node.initializer
      if (CHECKED_ATTRIBUTES.has(name) && value) {
        const texts = ts.isStringLiteral(value)
          ? [value.text]
          : ts.isJsxExpression(value) && value.expression
            ? literalTexts(value.expression)
            : []
        for (const text of texts) {
          if (hasUntranslatedLetters(text)) report(node, 'attribute', text)
        }
      }
    } else if (ts.isCallExpression(node) && isToastCall(node)) {
      const first = node.arguments[0] as ts.Expression | undefined
      if (first) {
        for (const text of literalTexts(first)) {
          if (hasUntranslatedLetters(text)) report(node, 'toast', text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function tsxFiles(dir: string): Array<string> {
  const out: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

// Every .tsx file under rootDir, except tests and src/components/ui (the
// shadcn primitives). `file` is relative to rootDir.
export function scanUntranslatedText(rootDir: string): Array<UntranslatedText> {
  const found: Array<UntranslatedText> = []
  for (const full of tsxFiles(rootDir).sort()) {
    const file = relative(rootDir, full)
    const parts = file.split(/[\\/]/)
    const underUi = parts.some((part, i) => part === 'components' && parts[i + 1] === 'ui')
    if (underUi) continue
    found.push(...findUntranslatedText(readFileSync(full, 'utf8'), file))
  }
  return found
}
