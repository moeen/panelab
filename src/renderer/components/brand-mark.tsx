import { cn } from '@/lib/utils'
import mark from '../../../resources/panelab-mark.svg?url'

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-5 shrink-0 bg-current', className)}
      style={{ maskImage: `url(${mark})`, maskSize: 'contain', maskRepeat: 'no-repeat' }}
    />
  )
}
