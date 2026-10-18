import { resolve, sep } from 'node:path'

export function rendererAsset(directory: string, requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl)
    const asset = resolve(directory, `.${decodeURIComponent(url.pathname)}`)
    return url.protocol === 'panelab:' &&
      url.hostname === 'app' &&
      asset.startsWith(`${directory}${sep}`)
      ? asset
      : null
  } catch {
    return null
  }
}
