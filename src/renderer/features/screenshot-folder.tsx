import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { send } from '@/lib/store'

// The folder is chosen in a native dialog by main; this control only shows and clears it.
export function ScreenshotFolder({ folder }: { folder: string | null }) {
  return (
    <>
      <span className="field-label mt-4 block" id="screenshot-folder-label">
        Screenshots
      </span>
      <div
        role="group"
        className="flex items-center gap-2"
        aria-labelledby="screenshot-folder-label"
      >
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={folder ?? undefined}
        >
          {folder ? (folder.split('/').filter(Boolean).at(-1) ?? folder) : 'Ask where to save'}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void send({ type: 'screenshots.folder', action: 'choose' })}
        >
          <FolderOpen />
          {folder ? 'Change…' : 'Choose folder…'}
        </Button>
        {folder ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void send({ type: 'screenshots.folder', action: 'clear' })}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </>
  )
}
