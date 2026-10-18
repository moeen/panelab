import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export function PopoverContent({
  className,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Popup>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner sideOffset={8} className="z-40">
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'w-80 rounded-xl bg-background p-4 text-sm text-foreground shadow-[0_8px_30px_rgb(0_0_0/0.2)] outline-none',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}
