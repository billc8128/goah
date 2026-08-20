"use client"

import * as React from "react"
import {
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useSpring,
  type SpringOptions,
} from "motion/react"

import { cn } from "@/lib/utils"

type BubbleColors = {
  first: string
  second: string
  third: string
  fourth: string
  fifth: string
  sixth: string
}

type BubbleBackgroundProps = React.ComponentPropsWithoutRef<"div"> & {
  interactive?: boolean
  transition?: SpringOptions
  colors?: BubbleColors
}

const BubbleBackground = React.forwardRef<HTMLDivElement, BubbleBackgroundProps>(function BubbleBackground(
  {
    className,
    children,
    interactive = false,
    transition = { stiffness: 100, damping: 20 },
    colors = {
      first: "36,71,216",
      second: "79,70,229",
      third: "107,122,255",
      fourth: "130,102,230",
      fifth: "188,197,255",
      sixth: "36,71,216",
    },
    style,
    ...props
  },
  forwardedRef,
) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(forwardedRef, () => containerRef.current as HTMLDivElement)
  const inView = useInView(containerRef, { amount: 0.1 })
  const reduceMotion = useReducedMotion()
  const [pageVisible, setPageVisible] = React.useState(true)
  const shouldMove = inView && pageVisible && !reduceMotion

  const mouseX = useMotionValue(0)
  const mouseY = useMotionValue(0)
  const springX = useSpring(mouseX, transition)
  const springY = useSpring(mouseY, transition)
  const boundsRef = React.useRef<DOMRect | null>(null)
  const animationFrameRef = React.useRef<number | null>(null)
  const filterId = `goo-${React.useId().replaceAll(":", "")}`

  React.useLayoutEffect(() => {
    const updateBounds = () => {
      boundsRef.current = containerRef.current?.getBoundingClientRect() ?? null
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    if (containerRef.current) observer.observe(containerRef.current)
    window.addEventListener("resize", updateBounds)
    window.addEventListener("scroll", updateBounds, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", updateBounds)
      window.removeEventListener("scroll", updateBounds)
    }
  }, [])

  React.useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden)
    updateVisibility()
    document.addEventListener("visibilitychange", updateVisibility)
    return () => document.removeEventListener("visibilitychange", updateVisibility)
  }, [])

  React.useEffect(() => {
    const element = containerRef.current
    if (!element || !interactive || !shouldMove) return

    const handleMouseMove = (event: MouseEvent) => {
      const bounds = boundsRef.current
      if (!bounds) return
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = requestAnimationFrame(() => {
        mouseX.set(event.clientX - bounds.left - bounds.width / 2)
        mouseY.set(event.clientY - bounds.top - bounds.height / 2)
      })
    }

    element.addEventListener("mousemove", handleMouseMove, { passive: true })
    return () => {
      element.removeEventListener("mousemove", handleMouseMove)
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
    }
  }, [interactive, mouseX, mouseY, shouldMove])

  const colorVariables = {
    "--first-color": colors.first,
    "--second-color": colors.second,
    "--third-color": colors.third,
    "--fourth-color": colors.fourth,
    "--fifth-color": colors.fifth,
    "--sixth-color": colors.sixth,
  } as React.CSSProperties

  return (
    <div
      ref={containerRef}
      data-slot="bubble-background"
      className={cn("relative size-full overflow-hidden bg-[#e9edff]", className)}
      style={{ ...colorVariables, ...style }}
      {...props}
    >
      <svg aria-hidden="true" className="absolute size-0">
        <defs>
          <filter id={filterId}>
            <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>

      <div className="absolute inset-0" style={{ filter: `url(#${filterId}) blur(32px)` }}>
        <motion.div
          className="absolute left-[10%] top-[10%] size-[80%] rounded-full bg-[radial-gradient(circle_at_center,rgba(var(--first-color),0.8)_0%,rgba(var(--first-color),0)_52%)] mix-blend-hard-light"
          animate={shouldMove ? { y: [-32, 32, -32] } : { y: 0 }}
          transition={{ duration: 30, ease: "easeInOut", repeat: Infinity }}
        />
        <motion.div
          className="absolute inset-0 flex origin-[18%_50%] items-center justify-center"
          animate={shouldMove ? { rotate: 360 } : { rotate: 20 }}
          transition={{ duration: 24, ease: "linear", repeat: Infinity }}
        >
          <div className="size-[78%] rounded-full bg-[radial-gradient(circle_at_center,rgba(var(--second-color),0.78)_0%,rgba(var(--second-color),0)_52%)] mix-blend-hard-light" />
        </motion.div>
        <motion.div
          className="absolute inset-0 flex origin-[82%_48%] items-center justify-center"
          animate={shouldMove ? { rotate: -360 } : { rotate: -24 }}
          transition={{ duration: 38, ease: "linear", repeat: Infinity }}
        >
          <div className="absolute left-[18%] top-[36%] size-[72%] rounded-full bg-[radial-gradient(circle_at_center,rgba(var(--third-color),0.72)_0%,rgba(var(--third-color),0)_52%)] mix-blend-hard-light" />
        </motion.div>
        <motion.div
          className="absolute left-[6%] top-[12%] size-[84%] rounded-full bg-[radial-gradient(circle_at_center,rgba(var(--fourth-color),0.6)_0%,rgba(var(--fourth-color),0)_52%)] mix-blend-hard-light"
          animate={shouldMove ? { x: [-30, 34, -30] } : { x: 0 }}
          transition={{ duration: 34, ease: "easeInOut", repeat: Infinity }}
        />
        <motion.div
          className="absolute inset-0 flex origin-[26%_72%] items-center justify-center"
          animate={shouldMove ? { rotate: 360 } : { rotate: 42 }}
          transition={{ duration: 42, ease: "linear", repeat: Infinity }}
        >
          <div className="size-[118%] rounded-full bg-[radial-gradient(circle_at_center,rgba(var(--fifth-color),0.62)_0%,rgba(var(--fifth-color),0)_54%)] mix-blend-hard-light" />
        </motion.div>
        {interactive && (
          <motion.div
            className="absolute inset-0 size-full rounded-full bg-[radial-gradient(circle_at_center,rgba(var(--sixth-color),0.55)_0%,rgba(var(--sixth-color),0)_52%)] mix-blend-hard-light opacity-70"
            style={{ x: springX, y: springY }}
          />
        )}
      </div>

      <div className="relative z-10 size-full">{children}</div>
    </div>
  )
})

export { BubbleBackground, type BubbleBackgroundProps }
