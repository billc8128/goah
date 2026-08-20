"use client"

import { useEffect, useRef, useState } from "react"

interface Particle {
  angle: number
  orbit: number
  radius: number
  speed: number
  alpha: number
  fade: number
}

interface SpaceBackgroundProps {
  particleCount?: number
  particleColor?: string
  backgroundColor?: string
  className?: string
  position?: "fixed" | "absolute"
  centerX?: number
  centerY?: number
  mobileCenterX?: number
  mobileCenterY?: number
}

function parseRgb(color: string): [number, number, number] | null {
  const value = color.trim()
  if (value.startsWith("#")) {
    const hex = value.slice(1).length === 3
      ? value.slice(1).split("").map((part) => `${part}${part}`).join("")
      : value.slice(1)
    return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)]
  }
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) return null
  const channels = match[1].split(",").map((part) => Number.parseFloat(part.trim()))
  return [channels[0], channels[1], channels[2]]
}

function contrastColor(background: string) {
  const rgb = parseRgb(background)
  if (!rgb) return "rgba(126, 167, 255, 0.72)"
  const luminance = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const lightness = 0.2126 * luminance[0] + 0.7152 * luminance[1] + 0.0722 * luminance[2]
  return lightness < 0.5 ? "rgba(126, 167, 255, 0.72)" : "rgba(26, 60, 115, 0.62)"
}

export function SpaceBackground({
  particleCount = 360,
  particleColor,
  backgroundColor = "transparent",
  className = "",
  position = "fixed",
  centerX = 0.5,
  centerY = 0.48,
  mobileCenterX = centerX,
  mobileCenterY = centerY,
}: SpaceBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animationRef = useRef<number | null>(null)
  const [color, setColor] = useState(particleColor)

  useEffect(() => {
    if (particleColor) { setColor(particleColor); return }
    const bodyColor = getComputedStyle(document.body).backgroundColor
    setColor(contrastColor(backgroundColor !== "transparent" ? backgroundColor : bodyColor))
  }, [backgroundColor, particleColor])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context || !color) return

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let width = 0
    let height = 0
    let dpr = 1
    let last = performance.now()
    let baseOrbit = 120
    let maxOrbit = 520
    let particles: Particle[] = []

    const createParticles = () => {
      const count = width < 640 ? Math.min(190, particleCount) : particleCount
      particles = Array.from({ length: count }, () => {
        const startsOnRing = Math.random() < 0.72
        return {
          angle: Math.random() * Math.PI * 2,
          orbit: startsOnRing ? baseOrbit + (Math.random() - 0.5) * 5 : baseOrbit + Math.random() * (maxOrbit - baseOrbit),
          radius: 0.55 + Math.random() * 2.5,
          speed: 0.00018 + Math.random() * 0.00058,
          alpha: 0.55 + Math.random() * 0.45,
          fade: 0.992 + Math.random() * 0.006,
        }
      })
    }

    const resize = () => {
      const bounds = position === "absolute" && canvas.parentElement
        ? canvas.parentElement.getBoundingClientRect()
        : { width: window.innerWidth, height: window.innerHeight }
      width = Math.max(1, Math.round(bounds.width))
      height = Math.max(1, Math.round(bounds.height))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      baseOrbit = Math.min(width, height) * (width < 1024 ? 0.2 : 0.205)
      maxOrbit = Math.max(baseOrbit + 40, Math.min(Math.max(width, height) * 0.72, 780))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      createParticles()
    }

    const draw = (now: number) => {
      const elapsed = Math.min(now - last, 40)
      last = now
      context.clearRect(0, 0, width, height)
      context.fillStyle = color
      const activeCenterX = width < 768 ? mobileCenterX : centerX
      const activeCenterY = width < 768 ? mobileCenterY : centerY
      const originX = width * activeCenterX
      const originY = height * activeCenterY

      for (const particle of particles) {
        if (!reduceMotion) {
          particle.angle += particle.speed * elapsed
          particle.orbit = Math.max(baseOrbit, particle.orbit - elapsed * 0.014)
          particle.radius *= particle.fade
          if (particle.radius < 0.42) {
            particle.orbit = baseOrbit + Math.random() * (maxOrbit - baseOrbit)
            particle.radius = 0.55 + Math.random() * 2.5
          }
        }
        const x = originX + Math.cos(particle.angle) * particle.orbit
        const y = originY + Math.sin(particle.angle) * particle.orbit
        context.globalAlpha = particle.alpha * Math.min(1, Math.max(0.32, particle.orbit / (baseOrbit * 1.4)))
        context.beginPath()
        context.arc(x, y, particle.radius, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
      if (!reduceMotion) animationRef.current = requestAnimationFrame(draw)
    }

    resize()
    draw(last)
    const resizeObserver = new ResizeObserver(resize)
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement)
    window.addEventListener("resize", resize)
    return () => {
      window.removeEventListener("resize", resize)
      resizeObserver.disconnect()
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    }
  }, [centerX, centerY, color, mobileCenterX, mobileCenterY, particleCount, position])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{ position, inset: 0, zIndex: 0, display: "block", width: "100%", height: "100%", background: backgroundColor, pointerEvents: "none" }}
    />
  )
}
