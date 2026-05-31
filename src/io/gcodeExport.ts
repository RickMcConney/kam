import { useToolStore } from '../store/toolStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { generateGcode, downloadGcode } from '../cam/gcode'
import { optimizeStartPoints } from '../cam/startOptimizer'

// Generate Grbl G-code for the current toolpaths and download it as `<fileName>.gcode`.
// `fileName` (no extension) is also emitted as the first comment line in the file so
// the operator can confirm the program when loading it on the machine.
export async function exportGcode(fileName: string): Promise<void> {
  await optimizeStartPoints()
  const { tools } = useToolStore.getState()
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
  const profile = usePostProcessorStore.getState().getActiveProfile()
  const { operations } = useToolpathStore.getState()
  const gcode = generateGcode(operations, toolsById, fileName, profile)
  downloadGcode(gcode, fileName)
}
