import type { Workspace } from '../../shared/contracts'

// Synchronized navigation moves every participating pane through its own history; otherwise the
// toolbar acts on the selected pane alone, which is also the pane the address bar shows.
export function historyTargets(workspace: Workspace, selected: string | null): string[] {
  const pane = workspace.panes.find((item) => item.id === selected)
  if (!pane) return []
  if (!workspace.sync.enabled || !workspace.sync.navigation || pane.excluded) return [pane.id]
  return workspace.panes.filter((item) => !item.excluded).map((item) => item.id)
}
