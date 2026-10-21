import { Tabs } from '@base-ui/react/tabs'
import { Bot, Cog, Globe, LoaderCircle, type LucideIcon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ClosableDialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { NativeSelect } from '@/components/ui/native-select'
import { EngineControls } from '@/features/engine-settings'
import { ScreenshotFolder } from '@/features/screenshot-folder'
import { openSettings, type SettingsTab, send } from '@/lib/store'
import type { AppSnapshot } from '../../shared/contracts'

const AgentControls = lazy(() =>
  import('./agent-settings').then((module) => ({ default: module.AgentControls })),
)
const tabs = [
  { id: 'general', label: 'General', icon: Cog },
  { id: 'engines', label: 'Browser engines', icon: Globe },
  { id: 'agents', label: 'Agents and MCP', icon: Bot },
] as const satisfies { id: SettingsTab; label: string; icon: LucideIcon }[]

export function Settings({ snapshot, tab }: { snapshot: AppSnapshot; tab: SettingsTab }) {
  return (
    <ClosableDialog onClose={() => openSettings(null)}>
      <DialogContent className="h-[min(620px,85vh)] w-[min(780px,calc(100vw-40px))] flex-row gap-0 overflow-hidden p-0">
        <Tabs.Root
          orientation="vertical"
          value={tab}
          onValueChange={(value) => {
            const next = tabs.find((item) => item.id === value)
            if (next) openSettings(next.id)
          }}
          className="flex min-h-0 flex-1"
        >
          <div className="settings-nav">
            <DialogTitle className="mb-3 px-2.5 text-xs font-semibold text-muted-foreground">
              Settings
            </DialogTitle>
            <Tabs.List className="flex flex-col gap-0.5" aria-label="Settings sections">
              {tabs.map(({ id, label, icon: Icon }) => (
                <Tabs.Tab key={id} value={id} className="settings-tab">
                  <Icon aria-hidden="true" />
                  {label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </div>
          {tabs.map(({ id, label }) => (
            <Tabs.Panel
              key={id}
              value={id}
              className="min-w-0 flex-1 overflow-y-auto px-7 pb-7 pt-5 outline-none"
            >
              <h2 className="mb-5 pr-8 text-lg font-semibold">{label}</h2>
              {id === 'general' ? (
                <General snapshot={snapshot} />
              ) : id === 'engines' ? (
                <>
                  <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
                    Choose engines to use. Disabling keeps downloads and pauses their previews.
                  </p>
                  <EngineControls snapshot={snapshot} />
                </>
              ) : (
                <Suspense fallback={null}>
                  <AgentControls status={snapshot.agent} />
                </Suspense>
              )}
            </Tabs.Panel>
          ))}
        </Tabs.Root>
      </DialogContent>
    </ClosableDialog>
  )
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function General({ snapshot }: { snapshot: AppSnapshot }) {
  const { settings, update } = snapshot
  const checking = update.state === 'checking'
  return (
    <div>
      <section className="settings-section" aria-labelledby="settings-appearance">
        <h3 id="settings-appearance" className="mb-3 text-sm font-semibold">
          Interface
        </h3>
        <div className="max-w-sm">
          <label className="field-label" htmlFor="appearance">
            Appearance
          </label>
          <NativeSelect
            id="appearance"
            value={settings.appearance}
            onChange={(event) =>
              void send({
                type: 'appearance.set',
                appearance:
                  event.target.value === 'dark'
                    ? 'dark'
                    : event.target.value === 'light'
                      ? 'light'
                      : 'system',
              })
            }
          >
            <option value="system">Follow macOS</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </NativeSelect>
          <label className="field-label mt-4" htmlFor="style-edits">
            Style edits
          </label>
          <NativeSelect
            id="style-edits"
            value={settings.styleEdits}
            onChange={(event) =>
              void send({
                type: 'style-edits.set',
                mode: event.target.value === 'rule' ? 'rule' : 'inline',
              })
            }
          >
            <option value="inline">Inline on the element</option>
            <option value="rule">Rule in Live CSS</option>
          </NativeSelect>
          <ScreenshotFolder folder={settings.screenshotFolder} />
        </div>
      </section>
      <section className="settings-section" aria-labelledby="settings-updates">
        <h3 id="settings-updates" className="mb-3 text-sm font-semibold">
          Updates
        </h3>
        <label htmlFor="auto-update" className="flex cursor-pointer items-start gap-3">
          <Checkbox
            id="auto-update"
            checked={settings.autoUpdate}
            onCheckedChange={(enabled) => void send({ type: 'update.auto.set', enabled })}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Check for updates automatically</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              Once a day, PaneLab asks GitHub for the latest release. Nothing downloads until you
              choose to update.
            </span>
          </span>
        </label>
        <div className="ml-7 mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" role="status">
            {checking
              ? 'Checking…'
              : update.state === 'error'
                ? update.error
                : settings.updateCheckedAt
                  ? `Last checked ${timeFormat.format(settings.updateCheckedAt)}`
                  : 'Not checked yet'}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={checking || update.state === 'downloading'}
            onClick={() => void send({ type: 'update.check' })}
          >
            {checking ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : null}
            Check now
          </Button>
        </div>
      </section>
    </div>
  )
}
