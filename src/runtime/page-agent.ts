import type { Selector } from '../shared/inspection'

export type PageAgentOptions = {
  binding: string
  key: string
  platform: string
  touch: boolean
  mobile: boolean
  chromium: boolean
}

// Everything PaneLab runs inside website documents. Serialized by Playwright as an init script, so
// all helpers must remain inside this function. Results are untrusted and validated by the runtime.
export function installPageAgent(options: PageAgentOptions): void {
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => options.platform })
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    get: () => (options.touch ? 5 : 0),
  })
  const post = (message: unknown) => {
    const binding: unknown = Reflect.get(window, options.binding)
    if (typeof binding === 'function') void Promise.resolve(binding(message)).catch(() => {})
  }
  const round = (value: number) => Math.round(value * 100) / 100
  const px = (value: string) => Number.parseFloat(value) || 0

  // Element identity shared by synchronization and inspection.
  const uniqueId = (element: Element) =>
    element.id !== '' && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1
  const segment = (element: Element) => {
    let index = 1
    for (
      let sibling = element.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    )
      if (sibling.tagName === element.tagName) index++
    return `${element.tagName.toLowerCase()}:nth-of-type(${index})`
  }
  // A unique structural selector anchored at the nearest unique id; scans build the same keys.
  const pathOf = (element: Element) => {
    const parts: string[] = []
    let cursor: Element | null = element
    while (cursor && parts.length < 64) {
      if (uniqueId(cursor)) {
        parts.unshift(`#${CSS.escape(cursor.id)}`)
        break
      }
      parts.unshift(segment(cursor))
      cursor = cursor.parentElement
    }
    return parts.join(' > ')
  }
  const identify = (element: Element, full: boolean): Selector[] => {
    const tag = element.tagName.toLowerCase()
    const selectors: Selector[] = []
    const testid = element.getAttribute('data-testid')
    if (testid) selectors.push({ kind: 'testid', value: testid, tag })
    if (element.id) selectors.push({ kind: 'id', value: element.id, tag })
    const name = element.getAttribute('name')
    if (name) selectors.push({ kind: 'name', value: name, tag })
    const label =
      element.getAttribute('aria-label') ??
      (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent?.trim() : null)
    if (label) selectors.push({ kind: 'label', value: label, tag })
    const text = element.textContent?.trim().replace(/\s+/g, ' ')
    if (text && text.length < 120 && ['a', 'button', 'summary', 'label'].includes(tag))
      selectors.push({ kind: 'text', value: text, tag })
    const path: string[] = []
    let cursor: Element | null = element
    while (cursor && path.length < 6) {
      const siblings: Element[] = cursor.parentElement
        ? Array.from(cursor.parentElement.children).filter(
            (sibling) => sibling.tagName === cursor?.tagName,
          )
        : [cursor]
      path.unshift(`${cursor.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(cursor) + 1})`)
      if (cursor.id) {
        path[0] = `#${CSS.escape(cursor.id)}`
        break
      }
      cursor = cursor.parentElement
    }
    const short = cursor !== null && cursor !== element && path.length < 6
    if (short) selectors.push({ kind: 'path', value: path.join(' > '), tag })
    // Framework markup often has no ids at all; a root-anchored path is the last resort.
    if (full || !short) selectors.push({ kind: 'path', value: pathOf(element), tag })
    const limit = full ? 1000 : 500
    return selectors.filter((selector) => selector.value.length <= limit).slice(0, 8)
  }

  // Synchronization capture: trusted user input becomes semantic actions for followers.
  const eventElement = (event: Event) =>
    event.composedPath().find((node): node is Element => node instanceof Element) ?? null
  const isPage = (element: Element | null) =>
    !element || element === document.body || element === document.documentElement
  // Native popups of dropdown selects are never streamed; PaneLab opens its own picker instead.
  const pickable = (element: Element | null | undefined): element is HTMLSelectElement =>
    window === window.top &&
    element instanceof HTMLSelectElement &&
    !element.multiple &&
    element.size <= 1 &&
    !element.disabled
  // Enter or Space on these produces a trusted click, which synchronizes on its own.
  const clickActivated =
    'a[href],button,summary,input:is([type="button"],[type="submit"],[type="reset"],[type="image"],[type="checkbox"],[type="radio"])'
  const nonTextInputs = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ])
  const editsText = (element: Element | null) =>
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !nonTextInputs.has(element.type)) ||
    (element instanceof HTMLElement && element.isContentEditable)
  // In multi-line fields Enter inserts a newline, which the input action already carries.
  const multiline = (element: Element | null) =>
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  // Outside text fields these keys scroll, move, or activate; inside them they only move the caret.
  const commandKeys = new Set([
    ' ',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ])
  // Escape and Enter replay; text editing reaches followers as input actions instead.
  const replayedKey = (key: string, element: Element | null) => {
    if (key === 'Escape') return true
    if ((key === 'Enter' || key === ' ') && element?.closest(clickActivated)) return false
    if (key === 'Enter') return !multiline(element)
    return commandKeys.has(key) && !editsText(element)
  }
  // Enter in a form field submits through a keyboard click (detail 0) on the default button.
  let activationAt = Number.NEGATIVE_INFINITY

  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted || event.button !== 0) return
      if (event.detail === 0 && event.timeStamp - activationAt < 500) return
      const element = eventElement(event)
      const target =
        element?.closest(
          'a,button,input,select,textarea,summary,[role="button"],[role="link"],[contenteditable]',
        ) ?? element
      // Selects open PaneLab's picker and synchronize the value they end up with.
      if (pickable(target)) return
      // Replaying a click on the page background would hit whatever sits at a follower's center.
      if (target && !isPage(target)) post({ kind: 'click', selectors: identify(target, false) })
    },
    true,
  )
  const inputAction = (
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement,
  ) => ({
    kind: 'input',
    selectors: identify(element, false),
    value:
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : element.innerText,
    checked:
      element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
        ? element.checked
        : null,
    selectionStart:
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.selectionStart
        : null,
    selectionEnd:
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.selectionEnd
        : null,
  })
  const onInput = (event: Event) => {
    if (!event.isTrusted) return
    const element = eventElement(event)
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      (element instanceof HTMLElement && element.isContentEditable)
    )
      post(inputAction(element))
  }

  let pickerSequence = 0
  let openPicker: { id: string; select: HTMLSelectElement } | null = null
  const groupOf = (option: HTMLOptionElement) =>
    option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null
  const unavailable = (option: HTMLOptionElement) =>
    option.disabled || Boolean(groupOf(option)?.disabled)
  const clean = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 200)
  const showPicker = (select: HTMLSelectElement) => {
    select.focus({ preventScroll: true })
    const options = Array.from(select.options).slice(0, 500)
    if (!options.length) return
    const id = `${documentId}p${++pickerSequence}`
    openPicker = { id, select }
    const box = boxModel(select)
    post({
      kind: 'picker',
      picker: {
        id,
        label: clean(
          select.getAttribute('aria-label') ?? select.labels?.[0]?.textContent ?? select.name,
        ),
        options: options.map((option) => {
          const group = groupOf(option)
          return {
            label: clean(option.label || option.text),
            group: group ? clean(group.label) : null,
            disabled: unavailable(option),
          }
        }),
        selectedIndex: select.selectedIndex < options.length ? select.selectedIndex : -1,
        rect: box.border,
        viewport: box.viewport,
      },
    })
  }
  // Script-driven changes are untrusted, so the agent reports the resulting value itself.
  const commitSelect = (select: HTMLSelectElement, index: number) => {
    const option = select.options[index]
    if (!option || unavailable(option) || select.selectedIndex === index) return
    select.selectedIndex = index
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
    post(inputAction(select))
  }
  const stepSelect = (select: HTMLSelectElement, key: string) => {
    const enabled = Array.from(select.options, (option, index) =>
      unavailable(option) ? -1 : index,
    ).filter((index) => index >= 0)
    const position = enabled.indexOf(select.selectedIndex)
    const next =
      key === 'Home'
        ? enabled[0]
        : key === 'End'
          ? enabled.at(-1)
          : key === 'ArrowDown'
            ? enabled[position + 1]
            : enabled[position < 0 ? enabled.length - 1 : position - 1]
    if (next !== undefined) commitSelect(select, next)
  }
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!event.isTrusted || event.button !== 0) return
      const select = eventElement(event)?.closest('select')
      if (!pickable(select)) return
      event.preventDefault()
      showPicker(select)
    },
    true,
  )

  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || event.repeat) return
      const element = eventElement(event)
      if (pickable(element)) {
        const modified = event.ctrlKey || event.metaKey
        if (
          !modified &&
          (['Enter', ' ', 'F4'].includes(event.key) ||
            (event.altKey && ['ArrowDown', 'ArrowUp'].includes(event.key)))
        ) {
          event.preventDefault()
          showPicker(element)
          return
        }
        if (
          !modified &&
          !event.altKey &&
          ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault()
          stepSelect(element, event.key)
          return
        }
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (!replayedKey(event.key, element)) return
      if (event.key === 'Enter' || event.key === ' ') activationAt = event.timeStamp
      post({
        kind: 'key',
        key: event.key,
        selectors: isPage(element) || !element ? [] : identify(element, false),
      })
    },
    true,
  )
  document.addEventListener('input', onInput, true)
  document.addEventListener('change', onInput, true)

  // HTML drag and drop replays as one action; pointer-driven drag libraries are not captured.
  let dragSource: Element | null = null
  document.addEventListener(
    'dragstart',
    (event) => {
      if (!event.isTrusted) return
      const element = eventElement(event)
      dragSource = element?.closest('[draggable="true"]') ?? element
    },
    true,
  )
  document.addEventListener(
    'drop',
    (event) => {
      const target = eventElement(event)
      if (event.isTrusted && dragSource?.isConnected && target && !isPage(target))
        post({
          kind: 'drag',
          selectors: identify(dragSource, false),
          target: identify(target, false),
        })
      dragSource = null
    },
    true,
  )
  document.addEventListener('dragend', () => {
    dragSource = null
  })
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let scrollTarget: EventTarget | null = null
  document.addEventListener(
    'scroll',
    (event) => {
      scrollTarget = event.target
      if (scrollTimer) return
      scrollTimer = setTimeout(() => {
        scrollTimer = undefined
        const isDocument = scrollTarget === document || scrollTarget === window
        const target = isDocument ? document.scrollingElement : scrollTarget
        if (!(target instanceof Element)) return
        post({
          kind: 'scroll',
          document: isDocument,
          selectors: isDocument ? [] : identify(target, false),
          x: target.scrollLeft / Math.max(1, target.scrollWidth - target.clientWidth),
          y: target.scrollTop / Math.max(1, target.scrollHeight - target.clientHeight),
        })
      }, 40)
    },
    { capture: true, passive: true },
  )

  // Inspection: node references stay valid for this document only.
  const documentId = Math.random().toString(36).slice(2, 12) || 'document'
  let counter = 0
  const refs = new WeakMap<Element, string>()
  const nodes = new Map<string, WeakRef<Element>>()
  const refOf = (element: Element) => {
    let ref = refs.get(element)
    if (!ref) {
      ref = `${documentId}:${++counter}`
      refs.set(element, ref)
      nodes.set(ref, new WeakRef(element))
    }
    return ref
  }
  const byRef = (ref: string) => {
    const element = nodes.get(ref)?.deref()
    return element?.isConnected ? element : null
  }
  const directText = (element: Element) =>
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(' ')
      .trim()
      .replace(/\s+/g, ' ')
  const labelOf = (element: Element) =>
    `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${Array.from(
      element.classList,
    )
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('')}`.slice(0, 200)
  const summary = (element: Element) => ({
    ref: refOf(element),
    tag: element.tagName.toLowerCase().slice(0, 80),
    id: element.id.slice(0, 200),
    classes: Array.from(element.classList)
      .slice(0, 4)
      .map((name) => name.slice(0, 200)),
    childCount: element.children.length,
    text: directText(element).slice(0, 120),
  })
  const cssSelectorOf = (element: Element) => {
    if (uniqueId(element)) return `#${CSS.escape(element.id)}`
    const testid = element.getAttribute('data-testid')
    if (testid) {
      const selector = `[data-testid="${CSS.escape(testid)}"]`
      if (document.querySelectorAll(selector).length === 1) return selector
    }
    return pathOf(element)
  }
  const targetOf = (element: Element) => ({
    selectors: identify(element, true),
    cssSelector: cssSelectorOf(element).slice(0, 2000),
    label: labelOf(element),
  })

  // Pane coordinates are CSS viewport pixels of the streamed frame, which follows the visual viewport.
  const viewport = () => {
    const visual = window.visualViewport
    return visual
      ? {
          x: visual.offsetLeft,
          y: visual.offsetTop,
          scale: visual.scale,
          width: visual.width,
          height: visual.height,
        }
      : { x: 0, y: 0, scale: 1, width: innerWidth, height: innerHeight }
  }
  type Box = { left: number; top: number; width: number; height: number }
  const inset = (box: Box, top: number, right: number, bottom: number, left: number): Box => ({
    left: box.left + left,
    top: box.top + top,
    width: Math.max(0, box.width - left - right),
    height: Math.max(0, box.height - top - bottom),
  })
  const boxModel = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const view = viewport()
    const screen = (box: Box) => ({
      x: round((box.left - view.x) * view.scale),
      y: round((box.top - view.y) * view.scale),
      width: round(box.width * view.scale),
      height: round(box.height * view.scale),
    })
    const border = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    const padding = inset(
      border,
      px(style.borderTopWidth),
      px(style.borderRightWidth),
      px(style.borderBottomWidth),
      px(style.borderLeftWidth),
    )
    const content = inset(
      padding,
      px(style.paddingTop),
      px(style.paddingRight),
      px(style.paddingBottom),
      px(style.paddingLeft),
    )
    const margin = inset(
      border,
      -px(style.marginTop),
      -px(style.marginRight),
      -px(style.marginBottom),
      -px(style.marginLeft),
    )
    return {
      margin: screen(margin),
      border: screen(border),
      padding: screen(padding),
      content: screen(content),
      viewport: { width: round(view.width * view.scale), height: round(view.height * view.scale) },
    }
  }
  const elementAt = (
    at: { kind: 'point'; x: number; y: number } | { kind: 'ref'; ref: string } | { kind: 'root' },
  ) => {
    if (at.kind === 'root') return document.body ?? document.documentElement
    if (at.kind === 'ref') return byRef(at.ref)
    const view = viewport()
    return document.elementFromPoint(at.x / view.scale + view.x, at.y / view.scale + view.y)
  }

  // Highlights follow scrolling, layout, and animation; only changes cross the binding.
  type Layer = 'hover' | 'target'
  const tracked: Record<Layer, { element: Element | null; last: string }> = {
    hover: { element: null, last: '' },
    target: { element: null, last: '' },
  }
  let frame = 0
  const tick = () => {
    frame = 0
    let active = false
    for (const layer of ['hover', 'target'] as const) {
      const item = tracked[layer]
      if (!item.element) continue
      const highlight = item.element.isConnected
        ? { box: boxModel(item.element), label: labelOf(item.element) }
        : null
      const serialized = JSON.stringify(highlight)
      if (serialized !== item.last) {
        item.last = serialized
        post({ kind: 'highlight', layer, highlight })
      }
      if (highlight) active = true
      else item.element = null
    }
    if (active) frame = requestAnimationFrame(tick)
  }
  const track = (layer: Layer, element: Element | null) => {
    const item = tracked[layer]
    if (item.element === element && element) return
    item.element = element
    item.last = ''
    if (!element) post({ kind: 'highlight', layer, highlight: null })
    cancelAnimationFrame(frame)
    tick()
  }

  type Condition = { label: string; applies: boolean; guarded: boolean }
  // Walks style rules depth-first in stylesheet order, tracking conditional group rules.
  const walkRules = (
    list: CSSRuleList,
    parent: Condition,
    visit: (rule: CSSStyleRule, condition: Condition) => boolean,
  ): boolean => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSImportRule) {
        let imported: CSSRuleList | null = null
        try {
          imported = rule.styleSheet?.cssRules ?? null
        } catch {
          // Cross-origin imports are unreadable, like their parent sheets would be.
        }
        if (imported && !walkRules(imported, parent, visit)) return false
        continue
      }
      if (rule instanceof CSSStyleRule) {
        if (!visit(rule, parent)) return false
        const nested: CSSRuleList | undefined = Reflect.get(rule, 'cssRules')
        if (nested?.length && !walkRules(nested, parent, visit)) return false
        continue
      }
      const children: unknown = Reflect.get(rule, 'cssRules')
      if (!(children instanceof CSSRuleList)) continue
      let label = ''
      let applies = parent.applies
      let guarded = parent.guarded
      if (rule instanceof CSSMediaRule) {
        label = `@media ${rule.media.mediaText}`
        applies &&= matchMedia(rule.media.mediaText).matches
      } else if (rule instanceof CSSSupportsRule) {
        label = `@supports ${rule.conditionText}`
        applies &&= CSS.supports(rule.conditionText)
        guarded = true
      } else {
        const kind = rule.constructor.name.replace(/^CSS|Rule$/g, '').toLowerCase()
        const detail = Reflect.get(rule, 'conditionText') ?? Reflect.get(rule, 'name') ?? ''
        label = `@${kind.replace(/block$/, '')} ${typeof detail === 'string' ? detail : ''}`.trim()
      }
      const condition = {
        label: [parent.label, label].filter(Boolean).join(' '),
        applies,
        guarded,
      }
      if (!walkRules(children, condition, visit)) return false
    }
    return true
  }
  let liveSheet: CSSStyleSheet | null = null
  const sheets = () => {
    const result: { sheet: CSSStyleSheet; label: string }[] = []
    Array.from(document.styleSheets).forEach((sheet, index) => {
      if (!sheet.disabled)
        result.push({ sheet, label: sheet.href ?? `inline <style> ${index + 1}` })
    })
    if (liveSheet && document.adoptedStyleSheets.includes(liveSheet))
      result.push({ sheet: liveSheet, label: 'PaneLab Live CSS' })
    return result
  }

  const describe = (args: { properties: string[] }, element: Element) => {
    const style = getComputedStyle(element)
    const computed: Record<string, string> = {}
    for (let index = 0; index < style.length; index++) {
      const name = style.item(index)
      if (!name.startsWith('--')) computed[name] = style.getPropertyValue(name).slice(0, 300)
    }
    for (const name of args.properties.slice(0, 200))
      computed[name] ??= style.getPropertyValue(name).slice(0, 300)
    const rules: { selector: string; condition: string; sheet: string; cssText: string }[] = []
    let unreadableSheets = 0
    for (const { sheet, label } of sheets()) {
      let list: CSSRuleList
      try {
        list = sheet.cssRules
      } catch {
        unreadableSheets++
        continue
      }
      if (sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches) continue
      walkRules(list, { label: '', applies: true, guarded: false }, (rule, condition) => {
        if (!condition.applies) return true
        let matches = false
        try {
          matches = element.matches(rule.selectorText)
        } catch {
          // Nested or engine-specific selectors may not be matchable directly.
        }
        if (matches)
          rules.push({
            selector: rule.selectorText.slice(0, 2000),
            condition: condition.label.slice(0, 500),
            sheet: label.slice(0, 500),
            cssText: rule.style.cssText.slice(0, 20_000),
          })
        return rules.length < 200
      })
    }
    const ancestors: ReturnType<typeof summary>[] = []
    for (
      let cursor = element.parentElement;
      cursor && ancestors.length < 60;
      cursor = cursor.parentElement
    )
      ancestors.unshift(summary(cursor))
    const rect = element.getBoundingClientRect()
    const edges = (prefix: string, suffix = '') =>
      ['Top', 'Right', 'Bottom', 'Left'].map((side) =>
        round(px(style.getPropertyValue(`${prefix}-${side.toLowerCase()}${suffix}`))),
      )
    return {
      node: summary(element),
      ancestors,
      attributes: Array.from(element.attributes)
        .slice(0, 50)
        .map((attribute) => [attribute.name.slice(0, 200), attribute.value.slice(0, 500)]),
      box: boxModel(element),
      metrics: {
        width: round(rect.width),
        height: round(rect.height),
        margin: edges('margin'),
        border: edges('border', '-width'),
        padding: edges('padding'),
      },
      computed,
      inlineText:
        element instanceof HTMLElement || element instanceof SVGElement
          ? element.style.cssText.slice(0, 20_000)
          : '',
      rules,
      unreadableSheets,
      target: targetOf(element),
    }
  }

  const originals = new WeakMap<Element, Map<string, [string, string]>>()
  const setInline = (args: { property: string; value: string | null }, element: Element) => {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false
    const { style } = element
    let saved = originals.get(element)
    if (!saved) {
      saved = new Map()
      originals.set(element, saved)
    }
    if (!saved.has(args.property))
      saved.set(args.property, [
        style.getPropertyValue(args.property),
        style.getPropertyPriority(args.property),
      ])
    if (args.value === null) {
      const [value, priority] = saved.get(args.property) ?? ['', '']
      if (value) style.setProperty(args.property, value, priority)
      else style.removeProperty(args.property)
      saved.delete(args.property)
      return true
    }
    const important = /!\s*important\s*$/i.test(args.value)
    style.setProperty(
      args.property,
      args.value.replace(/!\s*important\s*$/i, '').trim(),
      important ? 'important' : '',
    )
    return true
  }

  // Live CSS is one constructed sheet: no DOM node, removable, and re-applied by the runtime after navigation.
  const setLiveCss = (args: { css: string; enabled: boolean }) => {
    liveSheet ??= new CSSStyleSheet()
    const active = args.enabled && args.css.trim() !== ''
    liveSheet.replaceSync(active ? args.css : '')
    const others = document.adoptedStyleSheets.filter((sheet) => sheet !== liveSheet)
    document.adoptedStyleSheets = active ? [...others, liveSheet] : others
    const dropped: string[] = []
    if (!active) return dropped
    const source = args.css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of source.matchAll(
      /(?:^|[{;])\s*(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]+?)\s*(?=;|})/g,
    )) {
      const property = match[1] ?? ''
      const value = (match[2] ?? '').replace(/!\s*important$/i, '').trim()
      if (!property.startsWith('--') && !CSS.supports(property, value))
        dropped.push(`${property}: ${value}`.slice(0, 300))
      if (dropped.length >= 50) break
    }
    return dropped
  }

  const scan = () => {
    const limit = 4000
    const capped = 200
    const html = document.documentElement
    const viewportWidth = html.clientWidth
    const scrollWidth = document.scrollingElement?.scrollWidth ?? viewportWidth
    const pageOverflows = scrollWidth > viewportWidth + 1
    const rootStyles = [html, document.body]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element) => getComputedStyle(element).overflowX)
    const offsetX = scrollX
    const offsetY = scrollY
    const skipped = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE'])
    const interactive =
      'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"]'
    const idCounts = new Map<string, number>()
    const unique = (id: string) => {
      let count = idCounts.get(id)
      if (count === undefined) {
        count = document.querySelectorAll(`#${CSS.escape(id)}`).length
        idCounts.set(id, count)
      }
      return count === 1
    }
    type Item = {
      element: Element
      parent: number
      segment: string
      clipped: boolean
      fixed: boolean
    }
    const elements: {
      segment: string
      parent: number
      tag: string
      label: string
      x: number
      y: number
      width: number
      height: number
      visible: boolean
    }[] = []
    const overflow: { index: number; amount: number; hints: string[] }[] = []
    const candidates = new Set<number>()
    const clipped: { index: number; amount: number }[] = []
    const tapTargets: { index: number; width: number; height: number }[] = []
    const smallText: { index: number; size: number }[] = []
    const images: { index: number; natural: number; needed: number }[] = []
    const stack: Item[] = [
      {
        element: html,
        parent: -1,
        segment: uniqueId(html) ? `#${CSS.escape(html.id)}` : 'html:nth-of-type(1)',
        clipped: false,
        fixed: false,
      },
    ]
    let truncated = false
    while (stack.length) {
      const item = stack.pop()
      if (!item) break
      if (elements.length >= limit) {
        truncated = true
        break
      }
      const { element } = item
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const hidden = style.display === 'none'
      const visible =
        !hidden && style.visibility !== 'hidden' && (rect.width > 0 || rect.height > 0)
      const index =
        elements.push({
          segment: item.segment,
          parent: item.parent,
          tag: element.tagName.toLowerCase(),
          label: labelOf(element),
          x: round(rect.left + offsetX),
          y: round(rect.top + offsetY),
          width: round(rect.width),
          height: round(rect.height),
          visible,
        }) - 1
      if (hidden) continue
      const fixed = item.fixed || style.position === 'fixed'
      const text = directText(element)
      if (
        pageOverflows &&
        visible &&
        !item.clipped &&
        !fixed &&
        rect.right + offsetX > viewportWidth + 1
      ) {
        candidates.add(index)
        if (!candidates.has(item.parent) && overflow.length < capped) {
          const hints: string[] = []
          const parent = element.parentElement
          const parentStyle = parent ? getComputedStyle(parent) : null
          if (px(style.minWidth) > viewportWidth) hints.push(`min-width is ${style.minWidth}`)
          if (parent && rect.width > parent.getBoundingClientRect().width + 1)
            hints.push(
              `${round(rect.width)}px wide inside a ${round(parent.getBoundingClientRect().width)}px container`,
            )
          if (/nowrap|pre/.test(style.whiteSpace) && text)
            hints.push(`white-space: ${style.whiteSpace}`)
          if (
            text &&
            element.scrollWidth > element.clientWidth + 1 &&
            style.overflowWrap === 'normal' &&
            style.wordBreak === 'normal'
          )
            hints.push('Long unbreakable text; try overflow-wrap: anywhere')
          if (
            ['img', 'video', 'iframe', 'canvas', 'table', 'pre', 'svg'].includes(
              element.tagName.toLowerCase(),
            ) &&
            style.maxWidth === 'none'
          )
            hints.push('Media or table without max-width: 100%')
          if (parentStyle && /flex|grid/.test(parentStyle.display) && style.minWidth === 'auto')
            hints.push('Flex/grid item keeps min-width: auto; try min-width: 0')
          if (px(style.marginLeft) < 0 || px(style.marginRight) < 0) hints.push('Negative margin')
          if (style.transform !== 'none') hints.push('Transformed')
          if (style.position === 'absolute') hints.push('Absolutely positioned')
          overflow.push({ index, amount: round(rect.right + offsetX - viewportWidth), hints })
        }
      }
      const clips =
        element !== html &&
        element !== document.body &&
        (style.overflowX !== 'visible' || /paint|strict|content/.test(style.contain))
      if (
        visible &&
        /hidden|clip/.test(style.overflowX) &&
        text &&
        style.textOverflow !== 'ellipsis' &&
        element.scrollWidth > element.clientWidth + 1 &&
        clipped.length < capped
      )
        clipped.push({ index, amount: element.scrollWidth - element.clientWidth })
      if (
        options.touch &&
        visible &&
        element.matches(interactive) &&
        (rect.width < 24 || rect.height < 24) &&
        !(
          element.tagName === 'A' &&
          style.display === 'inline' &&
          directText(element.parentElement ?? element)
        ) &&
        tapTargets.length < capped
      )
        tapTargets.push({ index, width: round(rect.width), height: round(rect.height) })
      if (options.mobile && visible && text && px(style.fontSize) < 12 && smallText.length < capped)
        smallText.push({ index, size: px(style.fontSize) })
      if (
        element instanceof HTMLImageElement &&
        visible &&
        element.complete &&
        element.naturalWidth > 0 &&
        rect.width >= 32 &&
        images.length < capped
      ) {
        const needed = rect.width * devicePixelRatio
        if (
          (element.naturalWidth > needed * 2 && element.naturalWidth - needed > 400) ||
          (element.naturalWidth < needed * 0.75 && rect.width >= 64)
        )
          images.push({ index, natural: element.naturalWidth, needed: round(needed) })
      }
      const counts = new Map<string, number>()
      const children: Item[] = []
      for (const child of Array.from(element.children)) {
        const count = (counts.get(child.tagName) ?? 0) + 1
        counts.set(child.tagName, count)
        if (skipped.has(child.tagName)) continue
        children.push({
          element: child,
          parent: index,
          segment:
            child.id && unique(child.id)
              ? `#${CSS.escape(child.id)}`
              : `${child.tagName.toLowerCase()}:nth-of-type(${count})`,
          clipped: item.clipped || clips,
          fixed,
        })
      }
      for (let child = children.length - 1; child >= 0; child--) {
        const next = children[child]
        if (next) stack.push(next)
      }
    }

    const stylesheets: {
      key: string
      rules: number
      selectors: string[]
      properties: [string, string][]
    }[] = []
    let unreadable = 0
    Array.from(document.styleSheets).forEach((sheet, index) => {
      let list: CSSRuleList
      try {
        list = sheet.cssRules
      } catch {
        unreadable++
        return
      }
      let rules = 0
      const selectors: string[] = []
      const properties = new Map<string, string>()
      walkRules(list, { label: '', applies: true, guarded: false }, (rule, condition) => {
        if (condition.guarded) return true
        rules++
        if (selectors.length < 3000) selectors.push(rule.selectorText.slice(0, 500))
        for (const match of rule.style.cssText.matchAll(/(?:^|;)\s*([a-z][a-z-]*)\s*:/g)) {
          const property = match[1]
          if (property && !properties.has(property) && properties.size < 1000)
            properties.set(property, rule.selectorText.slice(0, 500))
        }
        return true
      })
      stylesheets.push({
        key: (sheet.href ?? `inline <style> ${index + 1}`).slice(0, 500),
        rules,
        selectors,
        properties: [...properties],
      })
    })
    return {
      url: location.href.slice(0, 8192),
      viewport: { width: viewportWidth, height: html.clientHeight },
      scrollWidth,
      rootClips: rootStyles.some((value) => value !== 'visible'),
      viewportMeta:
        document.querySelector('meta[name="viewport"]')?.getAttribute('content')?.slice(0, 500) ??
        null,
      truncated,
      elements,
      overflow,
      clipped,
      tapTargets,
      smallText,
      images,
      stylesheets: stylesheets.slice(0, 200),
      unreadableSheets: unreadable,
    }
  }

  // Page reading for agents: what a person sees and can operate, with act-ready selectors.
  const clip = (value: string | null | undefined, max: number) =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  const rendered = (element: Element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      (rect.width > 0 || rect.height > 0)
    )
  }
  const operable =
    'a[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="slider"]'
  const inputRoles: Record<string, string> = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    search: 'searchbox',
  }
  const roleOf = (element: Element) => {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0]
    if (explicit) return explicit
    if (element instanceof HTMLAnchorElement) return 'link'
    if (element instanceof HTMLInputElement) return inputRoles[element.type] ?? 'textbox'
    if (element instanceof HTMLSelectElement)
      return element.multiple || element.size > 1 ? 'listbox' : 'combobox'
    if (
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable)
    )
      return 'textbox'
    return element.tagName === 'SUMMARY' || element.tagName === 'BUTTON' ? 'button' : 'generic'
  }
  const nameOf = (element: Element) => {
    const labelledby = element
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    const labels =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? Array.from(element.labels ?? [], (label) => label.textContent ?? '').join(' ')
        : ''
    const buttonValue =
      element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)
        ? element.value
        : ''
    const own =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? ''
        : element instanceof HTMLElement
          ? element.innerText
          : element.textContent
    const image = element.querySelector('img[alt]')?.getAttribute('alt')
    for (const candidate of [
      labelledby,
      element.getAttribute('aria-label'),
      labels,
      buttonValue,
      own,
      image,
      element.getAttribute('title'),
      element.getAttribute('placeholder'),
    ]) {
      const name = clip(candidate, 200)
      if (name) return name
    }
    return ''
  }
  const secret = (element: Element) =>
    element instanceof HTMLInputElement &&
    (element.type === 'password' ||
      /cc-|one-time-code|current-password|new-password/.test(
        element.getAttribute('autocomplete') ?? '',
      ))
  const currentValue = (element: Element) => {
    if (element instanceof HTMLSelectElement)
      return clip(Array.from(element.selectedOptions, (option) => option.text).join(', '), 200)
    if (element instanceof HTMLTextAreaElement) return element.value.slice(0, 200)
    if (
      element instanceof HTMLInputElement &&
      !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(element.type)
    )
      return element.value.slice(0, 200)
    return null
  }
  const stateOf = (element: Element) => {
    const aria = (name: string) => element.getAttribute(`aria-${name}`)
    const states: string[] = []
    // :disabled also covers controls inside a disabled fieldset.
    if (element.matches(':disabled') || aria('disabled') === 'true') states.push('disabled')
    if (element instanceof HTMLInputElement && element.indeterminate) states.push('mixed')
    else if ((element instanceof HTMLInputElement && element.checked) || aria('checked') === 'true')
      states.push('checked')
    else if (aria('checked') === 'mixed') states.push('mixed')
    if (
      aria('expanded') === 'true' ||
      (element.tagName === 'SUMMARY' &&
        element.parentElement instanceof HTMLDetailsElement &&
        element.parentElement.open)
    )
      states.push('expanded')
    if (aria('selected') === 'true') states.push('selected')
    if (aria('pressed') === 'true') states.push('pressed')
    if (element.matches(':required') || aria('required') === 'true') states.push('required')
    if (
      ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        element.readOnly) ||
      aria('readonly') === 'true'
    )
      states.push('readonly')
    if (document.activeElement === element) states.push('focused')
    if (secret(element)) states.push('redacted')
    return states
  }
  const landmarkRoles: Record<string, string> = {
    HEADER: 'banner',
    NAV: 'navigation',
    MAIN: 'main',
    ASIDE: 'complementary',
    FOOTER: 'contentinfo',
    SEARCH: 'search',
  }
  const read = (args: {
    within: string | null
    offset: number
    maxText: number
    maxElements: number
  }) => {
    let root: Element = document.body ?? document.documentElement
    if (args.within) {
      const matches = document.querySelectorAll(args.within)
      if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'missing' }
      root = matches[0] ?? root
    }
    const all = (selector: string) => [
      ...(root.matches(selector) ? [root] : []),
      ...Array.from(root.querySelectorAll(selector)),
    ]
    const full = (root instanceof HTMLElement ? root.innerText : (root.textContent ?? ''))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const headings = all('h1,h2,h3,h4,h5,h6,[role="heading"]')
      .filter(rendered)
      .slice(0, 100)
      .map((element) => ({
        level: Math.min(
          6,
          Math.max(
            1,
            Number(element.getAttribute('aria-level')) || Number(element.tagName[1]) || 2,
          ),
        ),
        text: clip(element.textContent, 200),
      }))
    const landmarks = all(
      'header,nav,main,aside,footer,search,form[aria-label],form[aria-labelledby],section[aria-label],section[aria-labelledby],[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"],[role="search"],[role="region"],[role="form"]',
    )
      .filter(rendered)
      .slice(0, 50)
      .map((element) => ({
        role: (
          element.getAttribute('role') ??
          landmarkRoles[element.tagName] ??
          (element.tagName === 'FORM' ? 'form' : 'region')
        ).slice(0, 40),
        name: clip(
          element.getAttribute('aria-label') ??
            (element.getAttribute('aria-labelledby') ? nameOf(element) : ''),
          200,
        ),
      }))
    const candidates = all(operable).filter(rendered)
    const width = innerWidth
    const height = innerHeight
    const elements = candidates.slice(0, args.maxElements).map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        role: roleOf(element).slice(0, 40),
        name: nameOf(element),
        tag: element.tagName.toLowerCase().slice(0, 40),
        state: stateOf(element),
        value: secret(element) ? null : currentValue(element),
        href: element instanceof HTMLAnchorElement ? element.href.slice(0, 2000) : null,
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width,
        css: cssSelectorOf(element).slice(0, 2000),
        selectors: identify(element, false),
      }
    })
    return {
      status: 'read',
      title: clip(document.title, 500),
      url: location.href.slice(0, 8192),
      lang: clip(document.documentElement.lang, 35),
      headings,
      landmarks,
      text: {
        content: full.slice(args.offset, args.offset + args.maxText),
        offset: Math.min(args.offset, full.length),
        total: full.length,
      },
      elements,
      elementCount: candidates.length,
    }
  }

  const api = {
    hover: (args: { at: Parameters<typeof elementAt>[0] | null }) => {
      track('hover', args.at ? elementAt(args.at) : null)
      return null
    },
    element: (args: { at: Parameters<typeof elementAt>[0] }) => elementAt(args.at),
    target: (_args: null, element: Element) => targetOf(element),
    track: (args: { layer: Layer }, element: Element | null) => {
      track(args.layer, element)
      return null
    },
    describe,
    children: (args: { refs: string[] }) =>
      Object.fromEntries(
        args.refs.map((ref) => {
          const element = byRef(ref)
          return [ref, element ? Array.from(element.children).slice(0, 200).map(summary) : null]
        }),
      ),
    reveal: (_args: null, element: Element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      return null
    },
    setInline,
    setLiveCss,
    scan,
    read,
    supports: (args: { properties: string[] }) =>
      args.properties.filter((property) => !CSS.supports(property, 'initial')),
    // Applies a choice from PaneLab's picker; a stale picker or a removed select changes nothing.
    choosePicker: (args: { id: string; index: number | null }) => {
      const picker = openPicker
      if (picker?.id !== args.id || !picker.select.isConnected) return false
      openPicker = null
      picker.select.focus({ preventScroll: true })
      if (args.index !== null) commitSelect(picker.select, args.index)
      return true
    },
  }
  Object.defineProperty(window, options.key, { value: Object.freeze(api) })
}
