import { Check, ClipboardCopy, LoaderCircle, Plug, Terminal, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { copyText, request } from '@/lib/store'
import {
  type AgentClient,
  type AgentStatus,
  agentClientLabels,
  type ClientState,
} from '../../shared/agent'
import type { AppCommand } from '../../shared/contracts'

const stateLabels: Record<ClientState, string> = {
  configured: 'Uses PaneLab',
  available: 'Installed',
  missing: 'Not found',
}

export function AgentSettings({ status, onClose }: { status: AgentStatus; onClose: () => void }) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Client detection reads config files, so it refreshes when the dialog opens, not continuously.
  useEffect(() => {
    void request({ type: 'agent.status' })
  }, [])
  const perform = async (key: string, command: AppCommand) => {
    setPending(key)
    setError(null)
    const result = await request(command)
    if (!result.ok) setError(result.error)
    setPending(null)
    return result
  }
  const copyConfig = async (client: AgentClient) => {
    const result = await perform(`copy-${client}`, { type: 'agent.client.config', client })
    if (result.ok && result.text)
      await copyText(result.text, `${agentClientLabels[client]} configuration copied.`)
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <div className="pr-8">
          <DialogTitle className="text-lg font-semibold">Agents</DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Let coding agents open previews, take screenshots, and run checks through the PaneLab
            MCP server or the <span className="font-mono text-xs">panelab</span> command.
          </DialogDescription>
        </div>
        <div className="divide-y divide-border" aria-busy={pending !== null}>
          <section className="py-4 first:pt-0" aria-labelledby="agent-access-title">
            <label htmlFor="agent-access" className="flex cursor-pointer items-start gap-3">
              <Checkbox
                id="agent-access"
                checked={status.access}
                disabled={pending !== null}
                onCheckedChange={(enabled) =>
                  void perform('access', { type: 'agent.access.set', enabled })
                }
              />
              <span className="min-w-0 flex-1">
                <span id="agent-access-title" className="block text-sm font-semibold">
                  Let agents use this window
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  Agents connect through a local socket only your macOS account can open. They work
                  in a separate Agent workspace, which opens so you can watch. When this is off,
                  agents run their own previews without a window.
                </span>
              </span>
            </label>
            {status.access ? (
              <div className="ml-7 mt-3 flex flex-wrap items-center justify-between gap-2">
                <span
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  role="status"
                >
                  <span
                    className={status.connections ? 'status-dot ready' : 'status-dot'}
                    aria-hidden="true"
                  />
                  {!status.listening
                    ? 'Not listening'
                    : status.connections
                      ? `${status.connections} agent${status.connections === 1 ? '' : 's'} connected${status.lastOp ? ` · last: ${status.lastOp}` : ''}`
                      : 'Waiting for agents'}
                </span>
                {status.connections ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => void perform('disconnect', { type: 'agent.disconnect' })}
                  >
                    <Unplug />
                    Disconnect
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="py-4" aria-labelledby="agent-cli-title">
            <div className="flex items-start gap-3">
              <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <h3 id="agent-cli-title" className="text-sm font-semibold">
                  Command-line tool
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {status.cli.installed ? 'Installed at ' : 'Installs '}
                  <span className="font-mono">{status.cli.path}</span>
                  {status.cli.installed
                    ? '. Run panelab --help.'
                    : '. Add its folder to PATH to run panelab from any terminal.'}
                </p>
              </div>
              <Button
                variant={status.cli.installed ? 'ghost' : 'outline'}
                size="sm"
                disabled={pending !== null}
                onClick={() => void perform('cli', { type: 'agent.cli.install' })}
              >
                {pending === 'cli' ? (
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                ) : status.cli.installed ? (
                  <Check />
                ) : null}
                {status.cli.installed ? 'Reinstall' : 'Install'}
              </Button>
            </div>
          </section>

          <section className="pt-4" aria-labelledby="agent-clients-title">
            <h3 id="agent-clients-title" className="text-sm font-semibold">
              MCP clients
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Adding PaneLab edits the client's user configuration and keeps a .bak copy. Restart
              the client afterwards.
            </p>
            <ul className="mt-2">
              {status.clients.map((row) => (
                <li
                  key={row.client}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {agentClientLabels[row.client]}
                    </span>
                    <span
                      className="block truncate font-mono text-[10px] text-muted-foreground"
                      title={row.path}
                    >
                      {row.path}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {row.state === 'configured' ? (
                      <Check className="size-3.5" aria-hidden="true" />
                    ) : null}
                    {stateLabels[row.state]}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Copy ${agentClientLabels[row.client]} configuration`}
                    title="Copy configuration"
                    disabled={pending !== null}
                    onClick={() => void copyConfig(row.client)}
                  >
                    <ClipboardCopy />
                  </Button>
                  <Button
                    variant={row.state === 'configured' ? 'ghost' : 'outline'}
                    size="sm"
                    disabled={pending !== null}
                    aria-label={`Add PaneLab to ${agentClientLabels[row.client]}`}
                    onClick={() =>
                      void perform(`install-${row.client}`, {
                        type: 'agent.client.install',
                        client: row.client,
                      })
                    }
                  >
                    {pending === `install-${row.client}` ? (
                      <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Plug />
                    )}
                    {row.state === 'configured' ? 'Update' : 'Add'}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </div>
        {error ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
