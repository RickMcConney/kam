import { useEffect, useState, memo } from 'react'
import { Group, Image as KonvaImage } from 'react-konva'
import { useImageStore } from '../../store/imageStore'
import type { ImageRef } from '../../store/imageStore'

interface SingleImageProps {
  img: ImageRef
}

const SingleImage = memo(function SingleImage({ img }: SingleImageProps) {
  const [el, setEl] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    const image = new window.Image()
    image.onload = () => setEl(image)
    image.src = img.src
    return () => { image.onload = null }
  }, [img.src])

  if (!el) return null

  // The parent layer has scaleY=-scale (Y-flip). Inside it, we position this Group at the
  // top-left of the image in CNC Y-up coords (yMM + heightMM = CNC top), then apply
  // scaleY=-1 to cancel the Y-flip so the image renders right-side-up.
  return (
    <Group
      x={img.xMM}
      y={img.yMM + img.heightMM}
      scaleY={-1}
      listening={false}
    >
      <KonvaImage
        image={el}
        x={0}
        y={0}
        width={img.widthMM}
        height={img.heightMM}
        opacity={0.7}
      />
    </Group>
  )
})

export function ImageLayer() {
  const images = useImageStore((s) => s.images)
  return (
    <>
      {images.filter((img) => img.visible).map((img) => (
        <SingleImage key={img.id} img={img} />
      ))}
    </>
  )
}
