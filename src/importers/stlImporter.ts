import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { ImportedPath, StlModelBounds } from './svgImporter'
import { nextPathColor } from './svgImporter'
import { uid } from '../uid'

export type { StlModelBounds }

export function parseStlGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const loader = new STLLoader()
  return loader.parse(buffer)
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(binary)
}

export function importStl(
  buffer: ArrayBuffer,
  fileName: string,
  workpieceCX: number,
  workpieceCY: number,
): ImportedPath {
  const geo = parseStlGeometry(buffer)
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  if (!bb) { geo.dispose(); throw new Error('Could not compute STL bounding box') }

  const stlModelBounds: StlModelBounds = {
    minX: bb.min.x, maxX: bb.max.x,
    minY: bb.min.y, maxY: bb.max.y,
    minZ: bb.min.z, maxZ: bb.max.z,
  }
  geo.dispose()

  const modelW = stlModelBounds.maxX - stlModelBounds.minX
  const modelH = stlModelBounds.maxY - stlModelBounds.minY
  if (modelW < 0.001 || modelH < 0.001) {
    throw new Error('STL model has zero or near-zero XY dimensions')
  }

  const hw = modelW / 2
  const hh = modelH / 2
  const fmt = (n: number) => +n.toFixed(4)
  const d = `M${fmt(workpieceCX - hw)},${fmt(workpieceCY - hh)} L${fmt(workpieceCX + hw)},${fmt(workpieceCY - hh)} L${fmt(workpieceCX + hw)},${fmt(workpieceCY + hh)} L${fmt(workpieceCX - hw)},${fmt(workpieceCY + hh)} Z`

  return {
    id: uid('stl'),
    name: fileName,
    d,
    color: nextPathColor(),
    visible: true,
    stlSrc: arrayBufferToBase64(buffer),
    stlModelBounds,
  }
}
