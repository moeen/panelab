import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export function ConfirmDialog({
  title,
  action,
  onConfirm,
  onClose,
  children,
}: {
  title: string
  action: string
  onConfirm: () => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogTitle className="pr-8 text-lg font-semibold">{title}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
          {children}
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {action}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
