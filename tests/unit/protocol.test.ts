import { expect, test } from 'vitest'
import { rendererAsset } from '../../src/main/protocol'

test.each([
  ['panelab://app/index.html', '/private/tmp/panelab-renderer/index.html'],
  ['panelab://app/assets/app.js?version=1', '/private/tmp/panelab-renderer/assets/app.js'],
  ['panelab://app/assets/a%20b.js', '/private/tmp/panelab-renderer/assets/a b.js'],
  ['panelab://untrusted/index.html', null],
  ['https://app/index.html', null],
  ['panelab://app/%2e%2e%2fmain%2findex.js', null],
  ['panelab://app/%2e%2e%2fpanelab-renderer-sibling%2fsecret', null],
  ['panelab://app/%ZZ', null],
  ['not a URL', null],
])('resolves %s safely', (input, expected) => {
  expect(rendererAsset('/private/tmp/panelab-renderer', input)).toBe(expected)
})
