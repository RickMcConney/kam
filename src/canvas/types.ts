export type HandleType = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r'

export type LiveTransform =
  | { kind: 'translate'; pathIds: Set<string>; dx: number; dy: number }
  | { kind: 'scale'; pathIds: Set<string>; sx: number; sy: number; ax: number; ay: number }
  | { kind: 'rotate'; pathIds: Set<string>; angle: number; cx: number; cy: number }
