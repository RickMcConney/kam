import { buildProjectData } from './projectSave'
import { sanitizeFileName } from './filename'
import { useProjectStore } from '../store/projectStore'
import { useSaveDialogStore } from '../store/saveDialogStore'
import { useToolStore } from '../store/toolStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { generateGcode, generateGcodePerTool, downloadGcode } from '../cam/gcode'
import { optimizeStartPoints } from '../cam/startOptimizer'

// ─── File System Access API (Chromium only) — minimal local typing ──────────
// We type just what we use so this compiles regardless of the TS DOM lib version.
interface FsWritable { write(data: string): Promise<void>; close(): Promise<void> }
interface FsFileHandle { readonly name: string; createWritable(): Promise<FsWritable> }
interface FsDirHandle { getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle> }
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}
type ShowSaveFilePicker = (opts?: SaveFilePickerOptions) => Promise<FsFileHandle>
type ShowDirectoryPicker = () => Promise<FsDirHandle>

function getPicker(): ShowSaveFilePicker | null {
  const p = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker
  return typeof p === 'function' ? p : null
}

function getDirPicker(): ShowDirectoryPicker | null {
  const p = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker
  return typeof p === 'function' ? p : null
}

export function supportsFsAccess(): boolean {
  return getPicker() !== null
}

// In-memory file handles so a re-save overwrites the same file silently (real
// "Save" semantics). Handles aren't serializable, so they're never persisted;
// New/Open project clears them via clearFileHandles() to force a fresh prompt.
let projectHandle: FsFileHandle | null = null
let gcodeHandle: FsFileHandle | null = null

export function clearFileHandles() {
  projectHandle = null
  gcodeHandle = null
}

async function writeFile(handle: FsFileHandle, content: string) {
  const w = await handle.createWritable()
  await w.write(content)
  await w.close()
}

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, '')

// True if the user cancelled the native picker — treat as "handled, do nothing".
const isAbort = (e: unknown): boolean => (e as DOMException)?.name === 'AbortError'

// Returns true when the save was handled natively; false means the caller should
// fall back to the in-app filename modal.
async function saveProjectNative(saveAs: boolean): Promise<boolean> {
  const picker = getPicker()
  if (!picker) return false
  try {
    if (!projectHandle || saveAs) {
      const suggested = sanitizeFileName(useProjectStore.getState().name || 'project')
      projectHandle = await picker({
        suggestedName: `${suggested}.fkam`,
        types: [{ description: 'FreazyKam project', accept: { 'application/json': ['.fkam'] } }],
      })
    }
    // Name the project from the chosen file so the toolbar header matches.
    useProjectStore.getState().setName(stripExt(projectHandle.name))
    const json = JSON.stringify(buildProjectData(), null, 2)
    await writeFile(projectHandle, json)
    useProjectStore.getState().markClean()
    return true
  } catch (e) {
    if (isAbort(e)) return true
    console.error('Native project save failed:', e)
    return false
  }
}

async function exportGcodeNative(saveAs: boolean): Promise<boolean> {
  const picker = getPicker()
  if (!picker) return false
  try {
    // Open the picker FIRST, while the click's user-activation is still live —
    // before the async toolpath optimization, which would otherwise expire the
    // gesture and make showSaveFilePicker throw.
    if (!gcodeHandle || saveAs) {
      const suggested = sanitizeFileName(useProjectStore.getState().name || 'gcode')
      gcodeHandle = await picker({
        suggestedName: `${suggested}.gcode`,
        types: [{ description: 'G-code', accept: { 'text/plain': ['.gcode', '.nc', '.ngc', '.tap'] } }],
      })
    }
    await optimizeStartPoints()
    const { tools } = useToolStore.getState()
    const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
    const profile = usePostProcessorStore.getState().getActiveProfile()
    const { operations } = useToolpathStore.getState()
    const gcode = generateGcode(operations, toolsById, stripExt(gcodeHandle.name), profile)
    await writeFile(gcodeHandle, gcode)
    return true
  } catch (e) {
    if (isAbort(e)) return true
    console.error('Native G-code export failed:', e)
    return false
  }
}

// ─── Public entry points ────────────────────────────────────────────────────
// Use the native OS save dialog where available (Chromium), otherwise fall back
// to the in-app filename modal (Firefox/Safari). `saveAs` forces a fresh picker
// even when a handle already exists.

export async function triggerProjectSave(saveAs = false): Promise<void> {
  if (supportsFsAccess() && await saveProjectNative(saveAs)) return
  useSaveDialogStore.getState().openSaveDialog('project')
}

export async function triggerGcodeExport(saveAs = false): Promise<void> {
  if (supportsFsAccess() && await exportGcodeNative(saveAs)) return
  useSaveDialogStore.getState().openSaveDialog('gcode')
}

// Export one G-code file per tool/spindle speed. On Chromium the user picks a
// folder (one prompt) and all files are written into it; elsewhere each file is
// downloaded in turn. The directory picker is opened first so the click's
// user-activation is still live before the async toolpath optimization.
export async function triggerGcodeExportSplit(prefix?: string): Promise<void> {
  const baseName = sanitizeFileName(prefix?.trim() || useProjectStore.getState().name || 'gcode')
  const dirPicker = getDirPicker()
  let dir: FsDirHandle | null = null
  if (dirPicker) {
    try {
      dir = await dirPicker()
    } catch (e) {
      if (isAbort(e)) return // user cancelled the folder prompt
      dir = null // fall through to downloads
    }
  }

  await optimizeStartPoints()
  const { tools } = useToolStore.getState()
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
  const profile = usePostProcessorStore.getState().getActiveProfile()
  const { operations } = useToolpathStore.getState()
  const files = generateGcodePerTool(operations, toolsById, baseName, profile)
  if (files.length === 0) return

  if (dir) {
    for (const file of files) {
      const handle = await dir.getFileHandle(`${file.filename}.gcode`, { create: true })
      await writeFile(handle, file.gcode)
    }
  } else {
    // Sequential downloads — a short gap so browsers don't coalesce/block them.
    for (let i = 0; i < files.length; i++) {
      downloadGcode(files[i].gcode, files[i].filename)
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350))
    }
  }
}
