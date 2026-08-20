"use client"

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"

type GradientStop = {
  color: string
  stop: string
}

type GradientOrigin =
  | "bottom-middle"
  | "bottom-left"
  | "bottom-right"
  | "top-middle"
  | "top-left"
  | "top-right"
  | "left-middle"
  | "right-middle"
  | "center"

interface NoiseProps {
  patternSize?: number
  patternScaleX?: number
  patternScaleY?: number
  patternRefreshInterval?: number
  patternAlpha?: number
  intensity?: number
}

function Noise({
  patternSize = 100,
  patternScaleX = 1,
  patternScaleY = 1,
  patternRefreshInterval = 4,
  patternAlpha = 24,
  intensity = 0.8,
}: NoiseProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return

    const patternCanvas = document.createElement("canvas")
    patternCanvas.width = patternSize
    patternCanvas.height = patternSize
    const patternContext = patternCanvas.getContext("2d")
    if (!patternContext) return

    const image = patternContext.createImageData(patternSize, patternSize)
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let cssWidth = 0
    let cssHeight = 0
    let frame = 0
    let animationFrame = 0
    let visible = true
    let intersecting = true

    const resize = () => {
      const bounds = canvas.parentElement?.getBoundingClientRect()
      cssWidth = Math.max(1, Math.round(bounds?.width ?? window.innerWidth))
      cssHeight = Math.max(1, Math.round(bounds?.height ?? window.innerHeight))
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(cssWidth * dpr)
      canvas.height = Math.round(cssHeight * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const renderPattern = () => {
      for (let index = 0; index < image.data.length; index += 4) {
        const value = Math.random() * 255 * intensity
        image.data[index] = value
        image.data[index + 1] = value
        image.data[index + 2] = value
        image.data[index + 3] = patternAlpha
      }
      patternContext.putImageData(image, 0, 0)

      context.clearRect(0, 0, cssWidth, cssHeight)
      context.save()
      const scaleX = Math.max(0.001, patternScaleX)
      const scaleY = Math.max(0.001, patternScaleY)
      context.scale(scaleX, scaleY)
      const pattern = context.createPattern(patternCanvas, "repeat")
      if (pattern) {
        context.fillStyle = pattern
        context.fillRect(0, 0, cssWidth / scaleX, cssHeight / scaleY)
      }
      context.restore()
    }

    const loop = () => {
      if (visible && frame % Math.max(1, patternRefreshInterval) === 0) renderPattern()
      frame += 1
      animationFrame = requestAnimationFrame(loop)
    }

    resize()
    renderPattern()
    if (!reduceMotion && patternRefreshInterval > 0) loop()

    const resizeObserver = new ResizeObserver(resize)
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement)
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting
      visible = intersecting && !document.hidden
    })
    intersectionObserver.observe(canvas)
    const handleVisibility = () => {
      visible = intersecting && !document.hidden
    }
    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      document.removeEventListener("visibilitychange", handleVisibility)
      cancelAnimationFrame(animationFrame)
    }
  }, [intensity, patternAlpha, patternRefreshInterval, patternScaleX, patternScaleY, patternSize])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
}

interface GradientBackgroundProps {
  gradientType?: "radial-gradient" | "linear-gradient" | "conic-gradient"
  gradientSize?: string
  gradientOrigin?: GradientOrigin
  colors?: GradientStop[]
  enableNoise?: boolean
  noisePatternSize?: number
  noisePatternScaleX?: number
  noisePatternScaleY?: number
  noisePatternRefreshInterval?: number
  noisePatternAlpha?: number
  noiseIntensity?: number
  className?: string
  style?: CSSProperties
  children?: ReactNode
  customGradient?: string
}

const positions: Record<GradientOrigin, string> = {
  "bottom-middle": "50% 101%",
  "bottom-left": "0% 101%",
  "bottom-right": "100% 101%",
  "top-middle": "50% -1%",
  "top-left": "0% -1%",
  "top-right": "100% -1%",
  "left-middle": "-1% 50%",
  "right-middle": "101% 50%",
  center: "50% 50%",
}

const angles: Record<GradientOrigin, string> = {
  "bottom-middle": "0deg",
  "bottom-left": "45deg",
  "bottom-right": "315deg",
  "top-middle": "180deg",
  "top-left": "135deg",
  "top-right": "225deg",
  "left-middle": "90deg",
  "right-middle": "270deg",
  center: "0deg",
}

export function GradientBackground({
  gradientType = "radial-gradient",
  gradientSize = "125% 125%",
  gradientOrigin = "bottom-middle",
  colors = [
    { color: "rgba(36,71,216,0.95)", stop: "0%" },
    { color: "rgba(96,82,224,0.72)", stop: "34%" },
    { color: "rgba(180,170,255,0.5)", stop: "66%" },
    { color: "rgba(235,238,255,0.18)", stop: "100%" },
  ],
  enableNoise = true,
  noisePatternSize = 96,
  noisePatternScaleX = 1,
  noisePatternScaleY = 1,
  noisePatternRefreshInterval = 4,
  noisePatternAlpha = 24,
  noiseIntensity = 0.8,
  className = "",
  style,
  children,
  customGradient,
}: GradientBackgroundProps) {
  const stops = colors.map(({ color, stop }) => `${color} ${stop}`).join(",")
  const position = positions[gradientOrigin]
  const background = customGradient ?? (
    gradientType === "radial-gradient"
      ? `radial-gradient(${gradientSize} at ${position},${stops})`
      : gradientType === "linear-gradient"
        ? `linear-gradient(${angles[gradientOrigin]},${stops})`
        : `conic-gradient(from 0deg at ${position},${stops})`
  )

  return (
    <div className={`absolute inset-0 size-full ${className}`} style={{ background, ...style }}>
      {enableNoise && (
        <Noise
          patternSize={noisePatternSize}
          patternScaleX={noisePatternScaleX}
          patternScaleY={noisePatternScaleY}
          patternRefreshInterval={noisePatternRefreshInterval}
          patternAlpha={noisePatternAlpha}
          intensity={noiseIntensity}
        />
      )}
      {children}
    </div>
  )
}
