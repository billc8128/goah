import type { Metadata } from "next"
import "./globals.css"
import { Geist } from "next/font/google"

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" })

export const metadata: Metadata = {
  title: "Goah — The goal layer for agents",
  description: "A durable, goal-oriented agent harness that turns one objective into a long-running organization.",
  openGraph: {
    title: "Goah — The goal layer for agents",
    description: "One objective in. A durable agent organization moves.",
    type: "website",
  },
}

export const viewport = { themeColor: "#f1f1ee", colorScheme: "light" }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={geist.variable}>
      <body>{children}</body>
    </html>
  )
}
