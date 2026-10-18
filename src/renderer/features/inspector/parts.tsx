import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'

export function Empty({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children?: ReactNode
}) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center px-6 text-center">
      <p className="text-xs font-medium">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">{detail}</p>
      {children ? <div className="mt-3 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  )
}
export function FilterBar({
  label,
  query,
  onQuery,
  children,
}: {
  label: string
  query: string
  onQuery: (value: string) => void
  children?: ReactNode
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input
        className="h-7 border-0 bg-transparent text-xs"
        aria-label={`Filter ${label}`}
        placeholder={`Filter ${label}…`}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      {children}
    </div>
  )
}
export function sheetName(sheet: string): string {
  try {
    return new URL(sheet).pathname.split('/').pop() || sheet
  } catch {
    return sheet
  }
}
