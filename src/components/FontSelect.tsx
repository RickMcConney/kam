import { useState, useRef, useEffect, useCallback } from 'react'
import { AVAILABLE_FONTS, loadFont, getFont } from '../shapes/textGenerator'

function buildPreviewSVG(family: string, text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const font: any = getFont(family)
  if (!font) return ''
  try {
    const size = 32
    const path = font.getPath(text, 0, size, size)
    const bb = path.getBoundingBox()
    if (!bb || bb.x2 <= bb.x1 || bb.y2 <= bb.y1) return ''
    const pad = 3
    const vw = bb.x2 - bb.x1 + pad * 2
    const vh = bb.y2 - bb.y1 + pad * 2
    const d: string = path.toPathData(1)
    return (
      `<svg xmlns="http://www.w3.org/2000/svg"` +
      ` viewBox="${bb.x1 - pad} ${bb.y1 - pad} ${vw} ${vh}"` +
      ` height="44" preserveAspectRatio="xMinYMid meet"` +
      ` style="display:block;max-width:100%"` +
      ` aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`
    )
  } catch {
    return ''
  }
}

interface Props {
  value: string
  onChange: (family: string) => void
  previewText?: string
  className?: string
}

export default function FontSelect({ value, onChange, previewText, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [hoveredFamily, setHoveredFamily] = useState<string | null>(null)
  const [previewSVG, setPreviewSVG] = useState<string>('')
  const rootRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    const onMouse = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const sampleText = previewText?.trim() || 'AaBbCc'

  const showPreview = useCallback((family: string) => {
    const font = getFont(family)
    if (font) {
      setPreviewSVG(buildPreviewSVG(family, sampleText))
    } else {
      setPreviewSVG('')
      loadFont(family).then(() => {
        setPreviewSVG(buildPreviewSVG(family, sampleText))
      })
    }
  }, [sampleText])

  const handleEnter = useCallback((family: string) => {
    setHoveredFamily(family)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => showPreview(family), 60)
  }, [showPreview])

  const handleLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  // Refresh preview if previewText changes while a font is hovered
  useEffect(() => {
    if (hoveredFamily && open) showPreview(hoveredFamily)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleText])

  const selectedLabel = AVAILABLE_FONTS.find(f => f.family === value)?.label ?? value

  const btnCls =
    'w-full flex items-center justify-between gap-1 bg-gray-50 dark:bg-neutral-900 ' +
    'border border-gray-300 dark:border-neutral-700 rounded px-1.5 py-0.5 text-body ' +
    'text-gray-800 dark:text-neutral-200 text-left hover:border-gray-400 ' +
    'dark:hover:border-neutral-500 focus:outline-none focus:border-blue-500'

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen(o => !o)} className={btnCls}>
        <span className="truncate">{selectedLabel}</span>
        <svg className="shrink-0 w-3 h-3 opacity-50" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 4l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-0.5 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-600 rounded shadow-lg">
          {/* Font list */}
          <div className="overflow-y-auto max-h-44">
            {AVAILABLE_FONTS.map(f => {
              const active = f.family === value
              const hovered = f.family === hoveredFamily
              return (
                <button
                  key={f.family}
                  type="button"
                  onMouseEnter={() => handleEnter(f.family)}
                  onMouseLeave={handleLeave}
                  onClick={() => { onChange(f.family); setOpen(false) }}
                  className={[
                    'w-full px-2 py-1 text-body text-left',
                    active
                      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : hovered
                        ? 'bg-gray-100 dark:bg-neutral-700 text-gray-800 dark:text-neutral-200'
                        : 'text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700',
                  ].join(' ')}
                >
                  {f.label}
                </button>
              )
            })}
          </div>

          {/* Preview zone */}
          <div className="border-t border-gray-200 dark:border-neutral-600 px-2 py-1.5 min-h-[52px] flex items-center">
            {previewSVG
              ? <span className="text-gray-800 dark:text-neutral-200"
                  dangerouslySetInnerHTML={{ __html: previewSVG }} />
              : <span className="text-label text-gray-400 dark:text-neutral-500 italic">
                  {hoveredFamily ? 'Loading…' : 'Hover a font to preview'}
                </span>
            }
          </div>
        </div>
      )}
    </div>
  )
}
