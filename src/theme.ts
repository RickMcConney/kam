// ─── Icon sizes (px) ───────────────────────────────────────────────────────
// Used as <Icon size={ICON.sm} />. Change here to scale all icons.
export const ICON = {
  xs:  12,   // status indicators inline with text
  sm:  15,   // action buttons inside panels
  md:  32,   // toolbar / shape palette buttons
  lg:  22,   // empty-state illustrations
} as const

// ─── Material fill colors (light / dark) ───────────────────────────────────
import type { Material } from './store/workpieceStore'

export const MATERIAL_FILL: Record<Material, { light: string; dark: string }> = {
  pine:      { light: '#e8c98a', dark: '#7a5828' },
  oak:       { light: '#c8a060', dark: '#6a4820' },
  maple:     { light: '#f0d9a8', dark: '#8a6e3a' },
  walnut:    { light: '#7a4a28', dark: '#3a2010' },
  cherry:    { light: '#c47a45', dark: '#6a3a1a' },
  mdf:       { light: '#c8b89a', dark: '#5a4a38' },
  plywood:   { light: '#d4b07a', dark: '#6a5030' },
  hdpe:      { light: '#d8ecd8', dark: '#3a5a3a' },
  aluminum:  { light: '#c8ccd0', dark: '#4a5058' },
  other:     { light: '#e0e0e0', dark: '#404040' },
}

// ─── Canvas (Konva) colors ──────────────────────────────────────────────────
// Konva draws to a bitmap canvas — it can't use CSS variables.
// Call canvasTheme(darkMode) to get the correct set for the active theme.

const CANVAS_LIGHT = {
  ruler: {
    bg:     '#f3f4f6',
    border: '#d1d5db',
    corner: '#e5e7eb',
    tickMj: '#9ca3af',
    tickMn: '#d1d5db',
    label:  '#374151',
  },
  grid: {
    originLine: '#ef4444',
    axisMj:     '#9ca3af',
    axisNorm:   '#d1d5db',
    axisMn:     '#e5e7eb',
    mmLabel:    '#9ca3af',
  },
  workpiece: {},
  path: {
    selected: '#1e40af',
  },
}

const CANVAS_DARK = {
  ruler: {
    bg:     '#262626',
    border: '#404040',
    corner: '#404040',
    tickMj: '#737373',
    tickMn: '#404040',
    label:  '#d4d4d4',
  },
  grid: {
    originLine: '#ef4444',
    axisMj:     '#525252',
    axisNorm:   '#404040',
    axisMn:     '#333333',
    mmLabel:    '#737373',
  },
  workpiece: {},
  path: {
    selected: '#ffffff',
  },
}

export function canvasTheme(dark: boolean) {
  return dark ? CANVAS_DARK : CANVAS_LIGHT
}

// Legacy alias — used by layers that haven't been updated yet
export const CANVAS = CANVAS_LIGHT
