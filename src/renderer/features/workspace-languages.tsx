import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { saveWorkspace } from '@/lib/store'
import { parseLanguages } from '../../shared/emulation'

// Draft text stays local until it parses; a valid change reloads every preview in a new locale.
export function WorkspaceLanguages({ languages }: { languages: string[] }) {
  const saved = languages.join(', ')
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const parsed = parseLanguages(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter language tags such as en-US.')
      return
    }
    setDraft(null)
    setError(null)
    if (parsed.data.join(', ') !== saved)
      void saveWorkspace((value) => ({ ...value, languages: parsed.data }))
  }
  return (
    <>
      <label className="field-label mt-4" htmlFor="website-languages">
        Website languages
      </label>
      <Input
        id="website-languages"
        className="font-mono text-xs"
        spellCheck={false}
        value={draft ?? saved}
        placeholder="en-US, de"
        aria-invalid={error !== null}
        aria-describedby="website-languages-help"
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
          else if (event.key === 'Escape' && draft !== null) {
            event.stopPropagation()
            setDraft(null)
            setError(null)
          }
        }}
        onBlur={apply}
      />
      <p
        id="website-languages-help"
        className={`mt-1.5 text-[11px] leading-relaxed ${error ? 'text-destructive' : 'text-muted-foreground'}`}
        role={error ? 'alert' : undefined}
      >
        {error ??
          'Preferred first. Sets Accept-Language and navigator.language; changing it reloads every preview.'}
      </p>
    </>
  )
}
