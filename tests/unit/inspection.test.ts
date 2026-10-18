import { describe, expect, test } from 'vitest'
import { commandSchema } from '../../src/shared/contracts'
import { parseDeclarations, upsertDeclaration } from '../../src/shared/inspection'

describe('declaration parsing', () => {
  test('splits on top-level semicolons and reads priority', () => {
    expect(
      parseDeclarations(
        'background: url("a;b.png"); width: calc(1px + 2px) !important; content: \'x;y\'',
      ),
    ).toEqual([
      { property: 'background', value: 'url("a;b.png")', important: false },
      { property: 'width', value: 'calc(1px + 2px)', important: true },
      { property: 'content', value: "'x;y'", important: false },
    ])
  })
})

describe('Live CSS upserts', () => {
  test('appends a block, then replaces and extends it in place', () => {
    let css = upsertDeclaration('', '#card', 'color', 'red')
    expect(css).toBe('#card {\n  color: red !important;\n}\n')
    css = upsertDeclaration(css, '#card', 'color', 'blue')
    css = upsertDeclaration(css, '#card', 'gap', '4px')
    css = upsertDeclaration(css, 'main > p', 'margin', '0')
    expect(css).toBe(
      '#card {\n  color: blue !important;\n  gap: 4px !important;\n}\n\nmain > p {\n  margin: 0 !important;\n}\n',
    )
  })
  test('keeps hand-written rules around the edited block', () => {
    const css = upsertDeclaration('body { margin: 0 }\n', '.a', 'top', '0')
    expect(css).toBe('body { margin: 0 }\n\n.a {\n  top: 0 !important;\n}\n')
  })
})

describe('inspection commands', () => {
  const target = {
    selectors: [{ kind: 'path', value: '#card', tag: 'div' }],
    cssSelector: '#card',
    label: 'div#card',
  }
  test.each([
    { type: 'inspect.hover', paneId: 'p', at: { kind: 'point', x: 1, y: 2 } },
    { type: 'inspect.hover', paneId: 'p', at: null },
    { type: 'inspect.select', paneId: 'p', at: { kind: 'ref', ref: 'abc:12' } },
    { type: 'inspect.target', target, reveal: true },
    { type: 'inspect.style', target, property: '--accent', value: 'red' },
    { type: 'inspect.css', css: 'a{}', enabled: false },
    { type: 'style-edits.set', mode: 'rule' },
  ])('accepts $type', (command) => expect(commandSchema.safeParse(command).success).toBe(true))
  test.each([
    { type: 'inspect.select', paneId: 'p', at: { kind: 'ref', ref: '../x' } },
    { type: 'inspect.hover', paneId: 'p', at: { kind: 'point', x: Number.NaN, y: 0 } },
    { type: 'inspect.style', target, property: 'color;background', value: 'red' },
    { type: 'inspect.target', target: { ...target, selectors: [] }, reveal: false },
    { type: 'inspect.css', css: 'x'.repeat(200_001), enabled: true },
    { type: 'inspect.children', paneId: 'p', refs: [] },
    { type: 'style-edits.set', mode: 'outline' },
  ])('rejects malformed $type', (command) =>
    expect(commandSchema.safeParse(command).success).toBe(false),
  )
})
