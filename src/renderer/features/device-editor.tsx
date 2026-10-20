import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { send } from '@/lib/store'
import { type DeviceProfile, deviceSchema, engineLabels, engines } from '../../shared/contracts'

export function DeviceEditor({
  initial,
  onClose,
}: {
  initial: DeviceProfile | null
  onClose: () => void
}) {
  const [device, setDevice] = useState<DeviceProfile>(() =>
    initial
      ? {
          ...initial,
          id: initial.custom ? initial.id : crypto.randomUUID(),
          name: initial.custom ? initial.name : `${initial.name} custom`,
          custom: true,
          listed: true,
          nativeResolution: null,
          displayMode: '',
          sources: [],
          aliases: [],
        }
      : {
          id: crypto.randomUUID(),
          name: '',
          group: 'Phones',
          os: 'ios',
          viewport: { width: 390, height: 844 },
          screen: { width: 390, height: 844 },
          nativeResolution: null,
          displayMode: '',
          sources: [],
          aliases: [],
          listed: true,
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          orientation: 'portrait',
          defaultEngine: 'webkit',
          descriptor: null,
          custom: true,
          identities: { chromium: null, webkit: null, firefox: null },
        },
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const field = (kind: 'viewport' | 'screen', dimension: 'width' | 'height', value: string) =>
    setDevice((previous) => ({
      ...previous,
      [kind]: { ...previous[kind], [dimension]: Number(value) },
    }))
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <div className="pr-8">
          <DialogTitle className="text-lg font-semibold">
            {initial?.custom ? 'Edit custom device' : 'Create custom device'}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            Set the website viewport and the device’s emulated characteristics.
          </DialogDescription>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            const parsed = deviceSchema.safeParse(device)
            if (!parsed.success) {
              const issue = parsed.error.issues[0]
              setError(`${issue?.path.join('.')}: ${issue?.message}`)
              return
            }
            setSaving(true)
            void send({ type: 'device.save', device: parsed.data }).then((ok) => {
              setSaving(false)
              if (ok) onClose()
            })
          }}
        >
          <div>
            <label className="field-label" htmlFor="device-name">
              Device name
            </label>
            <Input
              id="device-name"
              autoFocus
              required
              maxLength={80}
              value={device.name}
              placeholder="My responsive device"
              onChange={(event) => setDevice({ ...device, name: event.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label" htmlFor="device-group">
                Category
              </label>
              <NativeSelect
                id="device-group"
                value={device.group}
                onChange={(event) => {
                  const group = deviceSchema.shape.group.parse(event.target.value)
                  setDevice({ ...device, group })
                }}
              >
                {['Phones', 'Tablets', 'Laptops', 'Desktops'].map((group) => (
                  <option key={group}>{group}</option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <label className="field-label" htmlFor="device-os">
                Emulated system
              </label>
              <NativeSelect
                id="device-os"
                value={device.os}
                onChange={(event) => {
                  const os = deviceSchema.shape.os.parse(event.target.value)
                  setDevice({
                    ...device,
                    os,
                    defaultEngine: os === 'ios' ? 'webkit' : 'chromium',
                    isMobile: os !== 'macos',
                    hasTouch: os !== 'macos',
                  })
                }}
              >
                <option value="ios">iOS / iPadOS</option>
                <option value="android">Android</option>
                <option value="macos">macOS</option>
              </NativeSelect>
            </div>
          </div>
          {(['viewport', 'screen'] as const).map((kind) => (
            <fieldset key={kind}>
              <legend className="mb-2 text-xs font-semibold">
                {kind === 'viewport' ? 'Viewport' : 'Screen'} dimensions · CSS pixels
              </legend>
              <div className="grid grid-cols-2 gap-3">
                {(['width', 'height'] as const).map((dimension) => (
                  <div key={dimension}>
                    <label
                      className="field-label text-muted-foreground"
                      htmlFor={`${kind}-${dimension}`}
                    >
                      {dimension === 'width' ? 'Width' : 'Height'}
                    </label>
                    <Input
                      id={`${kind}-${dimension}`}
                      type="number"
                      required
                      min={1}
                      max={8192}
                      value={device[kind][dimension]}
                      onChange={(event) => field(kind, dimension, event.target.value)}
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label" htmlFor="device-dpr">
                Device pixel ratio
              </label>
              <Input
                id="device-dpr"
                type="number"
                min={0.5}
                max={4}
                step="any"
                required
                value={device.deviceScaleFactor}
                onChange={(event) =>
                  setDevice({ ...device, deviceScaleFactor: Number(event.target.value) })
                }
              />
            </div>
            <div>
              <label className="field-label" htmlFor="device-orientation">
                Orientation
              </label>
              <NativeSelect
                id="device-orientation"
                value={device.orientation}
                onChange={(event) => {
                  const orientation = event.target.value === 'portrait' ? 'portrait' : 'landscape'
                  if (orientation !== device.orientation)
                    setDevice({
                      ...device,
                      orientation,
                      viewport: { width: device.viewport.height, height: device.viewport.width },
                      screen: { width: device.screen.height, height: device.screen.width },
                    })
                }}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </NativeSelect>
            </div>
          </div>
          <div className="flex gap-5">
            <label htmlFor="device-mobile" className="flex items-center gap-2 text-xs">
              <Checkbox
                id="device-mobile"
                checked={device.isMobile}
                onCheckedChange={(value) => setDevice({ ...device, isMobile: value })}
              />
              Mobile emulation
            </label>
            <label htmlFor="device-touch" className="flex items-center gap-2 text-xs">
              <Checkbox
                id="device-touch"
                checked={device.hasTouch}
                onCheckedChange={(value) => setDevice({ ...device, hasTouch: value })}
              />
              Touch input
            </label>
          </div>
          <details className="rounded-md bg-muted p-3">
            <summary className="cursor-pointer text-xs font-medium">
              Advanced browser identity
            </summary>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Leave fields empty to use engine-compatible defaults. Platform hints are emulated; OS
              features, fonts, codecs, and client-hint headers can differ from real hardware.
            </p>
            {engines.map((engine) => (
              <fieldset key={engine} className="mt-4 space-y-2">
                <legend className="mb-2 text-xs font-semibold">{engineLabels[engine]}</legend>
                <label htmlFor={`${engine}-ua`} className="block text-xs">
                  User agent
                  <Input
                    className="mt-1"
                    id={`${engine}-ua`}
                    value={device.identities[engine]?.userAgent ?? ''}
                    placeholder="Automatic"
                    onChange={(event) =>
                      setDevice({
                        ...device,
                        identities: {
                          ...device.identities,
                          [engine]: {
                            userAgent: event.target.value,
                            platform: device.identities[engine]?.platform ?? '',
                          },
                        },
                      })
                    }
                  />
                </label>
                <label htmlFor={`${engine}-platform`} className="block text-xs">
                  Navigator platform
                  <Input
                    className="mt-1"
                    id={`${engine}-platform`}
                    value={device.identities[engine]?.platform ?? ''}
                    placeholder="Automatic"
                    onChange={(event) =>
                      setDevice({
                        ...device,
                        identities: {
                          ...device.identities,
                          [engine]: {
                            userAgent: device.identities[engine]?.userAgent ?? '',
                            platform: event.target.value,
                          },
                        },
                      })
                    }
                  />
                </label>
              </fieldset>
            ))}
          </details>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save device'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
