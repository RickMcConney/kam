// Central color palette — edit here to retheme the whole app.

// All imported paths and created shapes share one color.
export const PATH_COLOR = '#60a5fa'  // blue-400

// Toolpath operation colors — fixed per type, stable across sessions.
export const OP_TYPE_COLORS: Record<string, string> = {
  profile:  '#f97316',  // orange-500
  pocket:   '#06b6d4',  // cyan-500
  drill:    '#10b981',  // emerald-500
  surface:  '#8b5cf6',  // violet-500
  vcarve:   '#ec4899',  // pink-500
  inlay:    '#eab308',  // yellow-500
}

// Simulation cut trail — matches the 3D carved-surface color.
export const SIM_CUT_COLOR       = '#ffcc00'
export const SIM_CUT_COLOR_THREE = 0xffcc00  // Three.js integer format

// 2D simulation tool indicator states.
export const SIM_TOOL_CUTTING_COLOR = '#ef4444'  // red   — actively cutting
export const SIM_TOOL_RAPID_COLOR   = '#9ca3af'  // gray  — rapid move
export const SIM_TOOL_OUTLINE_COLOR = '#ffffff'  // white — tool ring

// 3D view background.
export const THREE_BG_COLOR       = '#bfdbfe'  // blue-200 (light blue)
export const THREE_BG_COLOR_THREE = 0xbfdbfe   // Three.js integer format
