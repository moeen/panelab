import { runtimeCommandSchema } from '../shared/contracts'
import { BrowserRuntime, friendlyError } from './browser'
import { catalog } from './devices'

const parent = process.parentPort
if (!parent) throw new Error('Browser runtime must run inside an Electron utility process.')
const runtime = new BrowserRuntime((message) => parent.postMessage(message))
parent.on('message', (event) => {
  const value: unknown = event.data
  if (!value || typeof value !== 'object') return
  if (Reflect.get(value, 'type') === 'frames') {
    const port = event.ports[0]
    if (port) runtime.attachPort(port)
    return
  }
  if (Reflect.get(value, 'type') !== 'command') return
  const id: unknown = Reflect.get(value, 'id')
  const command = runtimeCommandSchema.safeParse(Reflect.get(value, 'command'))
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return
  if (!command.success) {
    parent.postMessage({
      type: 'reply',
      id,
      result: { ok: false, error: 'Invalid browser command.' },
    })
    return
  }
  void runtime
    .execute(command.data)
    .then((result) => parent.postMessage({ type: 'reply', id, result }))
    .catch((error: unknown) =>
      parent.postMessage({ type: 'reply', id, result: { ok: false, error: friendlyError(error) } }),
    )
})
parent.postMessage({ type: 'ready', catalog })
