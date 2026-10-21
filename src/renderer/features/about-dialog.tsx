import { ClipboardCopy, Download, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ClosableDialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { copyText, openOverlay, send } from '@/lib/store'
import icon from '../../../resources/panelab.svg?url'
import type { AboutInfo, LinkTarget, UpdateStatus } from '../../shared/contracts'

const links: { target: LinkTarget; label: string }[] = [
  { target: 'releases', label: 'Release notes' },
  { target: 'repo', label: 'GitHub' },
  { target: 'issues', label: 'Report an issue' },
  { target: 'license', label: 'MIT License' },
]

export const downloadPercent = (update: UpdateStatus): string =>
  `${Math.round((update.progress ?? 0) * 100)}%`

export function AboutDialog({ about, update }: { about: AboutInfo; update: UpdateStatus }) {
  const details = [
    `PaneLab ${about.version}`,
    `Electron ${about.electron} (Chromium ${about.chrome})`,
    `Node.js ${about.node}`,
    `Playwright ${about.playwright}`,
    `macOS ${about.macos} (arm64)`,
  ].join('\n')
  return (
    <ClosableDialog onClose={() => openOverlay(null)}>
      <DialogContent className="w-[min(420px,calc(100vw-40px))] gap-0 px-7 pb-5 pt-8">
        <div className="flex flex-col items-center text-center">
          <img src={icon} alt="" className="size-20" draggable={false} />
          <DialogTitle className="mt-3 text-lg font-semibold">PaneLab</DialogTitle>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            Version {about.version}
          </p>
          <DialogDescription className="mt-3 max-w-80 text-balance text-sm leading-relaxed text-muted-foreground">
            Real Chromium, WebKit, and Firefox, side by side.
          </DialogDescription>
        </div>
        <UpdatePanel update={update} />
        <nav
          aria-label="PaneLab links"
          className="mt-5 flex flex-wrap items-center justify-center gap-x-1 text-xs"
        >
          {links.map((link) => (
            <Button
              key={link.target}
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void send({ type: 'open.link', target: link.target })}
            >
              {link.label}
            </Button>
          ))}
        </nav>
        <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
          <span>© 2026 Moein Nemati</span>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 text-muted-foreground hover:text-foreground"
            onClick={() => void copyText(details, 'Version info copied.')}
          >
            <ClipboardCopy />
            Copy version info
          </Button>
        </div>
      </DialogContent>
    </ClosableDialog>
  )
}

function UpdatePanel({ update }: { update: UpdateStatus }) {
  const version = update.latest?.version
  const check = (
    <Button variant="outline" size="sm" onClick={() => void send({ type: 'update.check' })}>
      <RefreshCw />
      {update.state === 'error' ? 'Try again' : 'Check now'}
    </Button>
  )
  let title: string
  let note: string | null = null
  let action = check
  switch (update.state) {
    case 'checking':
      title = 'Checking for updates…'
      action = (
        <Button variant="outline" size="sm" disabled>
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          Checking
        </Button>
      )
      break
    case 'current':
      title = 'PaneLab is up to date.'
      note = update.blocked
      break
    case 'available':
      title = `Version ${version} is available.`
      note = update.blocked
      action = update.blocked ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void send({ type: 'open.link', target: 'releases' })}
        >
          <Download />
          Download manually
        </Button>
      ) : (
        <Button size="sm" onClick={() => void send({ type: 'update.download' })}>
          <Download />
          {update.error ? 'Retry download' : 'Download update'}
        </Button>
      )
      break
    case 'downloading':
      title = `Downloading version ${version}… ${downloadPercent(update)}`
      action = <span />
      break
    case 'ready':
      title = `Version ${version} is ready to install.`
      note = 'It also installs the next time you quit PaneLab.'
      action = (
        <Button size="sm" onClick={() => void send({ type: 'update.install' })}>
          <RotateCw />
          Restart to update
        </Button>
      )
      break
    case 'error':
      title = 'Could not check for updates.'
      break
    default:
      title = 'Updates come from PaneLab’s GitHub releases.'
  }
  const error = update.error
  return (
    <section
      aria-label="Updates"
      aria-busy={update.state === 'checking' || update.state === 'downloading'}
      className="mt-6 rounded-lg bg-muted px-4 py-3"
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <p className="min-w-0 text-sm font-medium" role="status">
          {title}
        </p>
        {action}
      </div>
      {update.state === 'downloading' ? (
        <div
          className="mt-2.5 h-1 overflow-hidden rounded-full bg-border"
          role="progressbar"
          aria-label="Update download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((update.progress ?? 0) * 100)}
        >
          <div
            className="h-full origin-left rounded-full bg-primary transition-transform duration-200 motion-reduce:transition-none"
            style={{ transform: `scaleX(${update.progress ?? 0})` }}
          />
        </div>
      ) : null}
      {note || error || (version && update.state !== 'downloading') ? (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs leading-relaxed">
          {error ? (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          ) : note ? (
            <span className="text-muted-foreground">{note}</span>
          ) : null}
          {version ? (
            <button
              type="button"
              className="rounded-sm font-medium underline decoration-foreground/30 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => void send({ type: 'open.link', target: 'releases' })}
            >
              What’s new in {version}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
