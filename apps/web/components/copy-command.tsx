"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"

export function CopyCommand({ command, theme = "dark" }: { command: string; theme?: "light" | "dark" }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={copy}
      aria-label={copied ? "Command copied" : "Copy install command"}
      className={theme === "light"
        ? "size-9 rounded-full text-black/45 hover:bg-black/5 hover:text-black"
        : "size-9 rounded-full text-white/55 hover:bg-white/8 hover:text-white"}
    >
      {copied ? <Check className="size-4 text-[#78efa5]" /> : <Copy className="size-4" />}
    </Button>
  )
}
