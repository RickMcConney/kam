// Copying paths from one project to another.
//
// The gesture is Ctrl+C / Ctrl+V and the payload is the app's OWN objects, not
// SVG — which is the whole point. A path here is not an outline: it carries the
// parameters it was generated from (`shapeParams`), the corner recipe `d` was
// cut with, the provenance a form reopens on, and its group, clock and
// user-group membership. An SVG round-trip would hand back a dead outline, and a
// gear that cannot be re-cut at m4 is not a copy of a gear.
//
// It rides the SYSTEM clipboard as text, so it crosses browser tabs and windows
// — which is what "another project" means here — and it goes through the
// document's own `copy`/`paste` events rather than `navigator.clipboard`, which
// needs a permission prompt to READ.
//
// THE WORK IS THE ID REMAP, not the transfer. Every id in the payload has to be
// reissued, and reissued CONSISTENTLY: a gear's three parts share a `groupId`
// and must go on sharing one, a clock's parts share a `clockId`, a user group is
// a chain of ids, and a pattern's copies share a `definition.id`. Reuse an id
// and the paste joins the group it was copied from; reissue them independently
// and a gear arrives as three unrelated paths that no longer regenerate
// together.

import { uid } from '../uid'
import { usePathsStore } from '../store/pathsStore'
import { useTabStore, type Tab } from '../store/tabStore'
import { useUIStore } from '../store/uiStore'
import { translateD } from '../canvas/selectionUtils'
import { translateShapeParams } from '../shapes/shapeGenerators'
import type { ImportedPath } from '../importers/svgImporter'

/** Marks the text as ours. Anything else on the clipboard is left to the browser. */
const MARKER = 'freazykam/paths'
const VERSION = 1

/** How far a paste lands from the original when it recognises its own project —
 *  the same nudge `duplicateSelected` uses, and for the same reason: a copy
 *  landing exactly on top of what it was copied from looks like nothing
 *  happened. */
const SAME_DOC_OFFSET_MM = 5

export interface ClipboardPayload {
  kind: typeof MARKER
  version: number
  paths: ImportedPath[]
  /** Holding tabs belong TO a path and reference nothing else, so they travel
   *  with it. Operations deliberately do NOT: they name a tool and can sit on
   *  another operation's floor (`startFrom`), neither of which the other project
   *  need have, and a half-valid operation is worse than none. */
  tabs: Tab[]
}

export function serializePaths(paths: ImportedPath[], tabs: Tab[]): string {
  const ids = new Set(paths.map((p) => p.id))
  const payload: ClipboardPayload = {
    kind: MARKER,
    version: VERSION,
    paths,
    tabs: tabs.filter((t) => ids.has(t.pathId)),
  }
  return JSON.stringify(payload)
}

/** The payload in this text, or null if it is not ours — which is most text. */
export function parsePaths(text: string): ClipboardPayload | null {
  if (!text || !text.includes(MARKER)) return null
  try {
    const data = JSON.parse(text) as Partial<ClipboardPayload>
    if (data?.kind !== MARKER || !Array.isArray(data.paths) || data.paths.length === 0) return null
    return {
      kind: MARKER,
      version: typeof data.version === 'number' ? data.version : VERSION,
      paths: data.paths as ImportedPath[],
      tabs: Array.isArray(data.tabs) ? (data.tabs as Tab[]) : [],
    }
  } catch {
    return null
  }
}

/**
 * The payload as objects this document can hold: every id reissued, everything
 * that was shared still shared, and everything pointing OUT of the copied set
 * let go of.
 *
 * `existingIds` are the paths already in the document. They decide two things:
 * whether this is a paste back into the project the copy came from (so it is
 * nudged clear rather than landing exactly on the original), and nothing else —
 * ids are reissued either way, because a paste is a new object even when it is a
 * copy of one that is still there.
 */
export function remapForPaste(
  payload: ClipboardPayload,
  existingIds: Set<string>,
): { paths: ImportedPath[]; tabs: Tab[] } {
  const sameDoc = payload.paths.some((p) => existingIds.has(p.id))
  const shift = sameDoc ? SAME_DOC_OFFSET_MM : 0

  // One new id per old id, whatever kind of id it is — issued once and reused,
  // which is what keeps a group a group.
  const fresh = new Map<string, string>()
  const remap = (old: string | undefined, prefix: string): string | undefined => {
    if (!old) return undefined
    const seen = fresh.get(old)
    if (seen) return seen
    const made = uid(prefix)
    fresh.set(old, made)
    return made
  }

  const copiedIds = new Set(payload.paths.map((p) => p.id))
  const pathId = (old: string) => remap(old, 'path-paste')!
  // Reserve the path ids first: a definition's sources are path ids, and they
  // must come out as the SAME new ids as the paths they name.
  for (const p of payload.paths) pathId(p.id)

  const paths = payload.paths.map((p) => {
    const out: ImportedPath = {
      ...p,
      id: pathId(p.id),
      groupId: remap(p.groupId, 'shape-group'),
      clockId: remap(p.clockId, 'clock'),
      userGroups: p.userGroups?.map((g) => remap(g, 'ugroup')!),
    }
    // PROVENANCE ONLY SURVIVES IF WHAT IT CAME FROM CAME TOO. A pattern reopens
    // over its sources and an offset re-cuts from its own; with those left
    // behind the form has nothing to re-run and the chip is a lie. The geometry
    // is still perfectly good — it just stops claiming it can be regenerated.
    const def = p.definition
    if (def) {
      const sources = def.kind === 'pattern' || def.kind === 'boolean' ? def.sourceIds : [def.sourceId]
      out.definition = sources.every((id) => copiedIds.has(id))
        ? {
            ...def,
            id: remap(def.id, 'def')!,
            ...(def.kind === 'pattern' || def.kind === 'boolean'
              ? { sourceIds: def.sourceIds.map(pathId) }
              : { sourceId: pathId(def.sourceId) }),
          } as typeof def
        : undefined
    }
    if (shift !== 0) {
      out.d = translateD(p.d, shift, shift)
      // The params are the definition of a parametric shape, so they move with
      // it or the next spinner step puts the copy back where the original is.
      if (p.shapeParams) out.shapeParams = translateShapeParams(p.shapeParams, shift, shift)
      if (p.corners) out.corners = { ...p.corners, baseD: translateD(p.corners.baseD, shift, shift) }
    }
    return out
  })

  const tabs = payload.tabs
    .filter((t) => copiedIds.has(t.pathId))
    .map((t) => ({ ...t, id: uid('tab'), pathId: pathId(t.pathId) }))

  return { paths, tabs }
}

/** Put the current selection on the clipboard. Returns how many paths went. */
export function copySelectionToClipboard(e: ClipboardEvent): number {
  const { paths, selectedIds } = usePathsStore.getState()
  const picked = paths.filter((p) => selectedIds.includes(p.id))
  if (picked.length === 0) return 0
  e.clipboardData?.setData('text/plain', serializePaths(picked, useTabStore.getState().tabs))
  e.preventDefault()
  return picked.length
}

/** Take paths off the clipboard text, if it is ours. Returns how many arrived. */
export function pastePathsFromText(text: string): number {
  const payload = parsePaths(text)
  if (!payload) return 0
  const store = usePathsStore.getState()
  const { paths, tabs } = remapForPaste(payload, new Set(store.paths.map((p) => p.id)))
  if (paths.length === 0) return 0
  store.addPaths(paths, { source: 'paste', label: paths.length === 1 ? paths[0].name : `Paste ×${paths.length}` })
  store.setSelectedIds(paths.map((p) => p.id))
  if (tabs.length > 0) useTabStore.getState().replaceTabs([...useTabStore.getState().tabs, ...tabs])
  return paths.length
}

/**
 * Wire the document's clipboard events. Installed once from App.
 *
 * It steps aside for ordinary text: a field being typed in, or any live text
 * selection on the page — the G-code viewer copies its own selection that way,
 * and a document-level handler that overwrote the clipboard afterwards would
 * take that away.
 */
export function installPathClipboard(): () => void {
  const inText = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null
    if (!el) return false
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  }
  const textSelected = () => (window.getSelection()?.toString().length ?? 0) > 0

  const onCopy = (e: ClipboardEvent) => {
    if (inText(e.target) || textSelected()) return
    const n = copySelectionToClipboard(e)
    if (n > 0) useUIStore.getState().showStatus(`${n} path${n > 1 ? 's' : ''} copied — paste into any project.`)
  }
  const onCut = (e: ClipboardEvent) => {
    if (inText(e.target) || textSelected()) return
    const n = copySelectionToClipboard(e)
    if (n === 0) return
    usePathsStore.getState().deleteSelected()
    useUIStore.getState().showStatus(`${n} path${n > 1 ? 's' : ''} cut.`)
  }
  const onPaste = (e: ClipboardEvent) => {
    if (inText(e.target)) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const n = pastePathsFromText(text)
    if (n === 0) return                     // not ours — leave it to the browser
    e.preventDefault()
    useUIStore.getState().showStatus(`${n} path${n > 1 ? 's' : ''} pasted.`)
  }

  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCut)
  document.addEventListener('paste', onPaste)
  return () => {
    document.removeEventListener('copy', onCopy)
    document.removeEventListener('cut', onCut)
    document.removeEventListener('paste', onPaste)
  }
}
