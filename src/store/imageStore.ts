import { create } from 'zustand'

export interface ImageRef {
  id: string
  name: string
  visible: boolean
  src: string      // base64 data URL
  xMM: number      // CNC mm, left edge
  yMM: number      // CNC mm, bottom edge (Y-up)
  widthMM: number
  heightMM: number
}

interface ImageState {
  images: ImageRef[]
  addImage: (img: ImageRef) => void
  deleteImage: (id: string) => void
  toggleVisibility: (id: string) => void
  replaceImages: (imgs: ImageRef[]) => void
}

let _imgCounter = 0
export function nextImageId() { return `img-${++_imgCounter}-${Date.now()}` }

export const useImageStore = create<ImageState>()((set) => ({
  images: [],

  addImage: (img) => set((s) => ({ images: [...s.images, img] })),

  deleteImage: (id) => set((s) => ({ images: s.images.filter((i) => i.id !== id) })),

  toggleVisibility: (id) => set((s) => ({
    images: s.images.map((i) => i.id === id ? { ...i, visible: !i.visible } : i),
  })),

  replaceImages: (imgs) => set({ images: imgs }),
}))
