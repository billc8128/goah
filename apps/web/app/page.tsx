import Image from "next/image"
import { ArrowUpRight, Check, Code2, Database, Eye, Network, TimerReset } from "lucide-react"

import { CopyCommand } from "@/components/copy-command"
import { Button } from "@/components/ui/button"
import { BubbleBackground } from "@/components/ui/components-backgrounds-bubble"
import { GradientBackground } from "@/components/ui/noisy-gradient-backgrounds"

const githubUrl = "https://github.com/billc8128/opengoah"
const npmUrl = "https://www.npmjs.com/package/@goah/cli"

const principles = [
  { icon: Database, name: "Ledger", detail: "Every session, tool call, handoff, and decision becomes durable history." },
  { icon: Eye, name: "Observation", detail: "Every goal keeps one explicit method for judging progress and completion." },
  { icon: TimerReset, name: "Time", detail: "Schedules, wakes, and mail let the organization continue after the process exits." },
  { icon: Network, name: "Organization", detail: "A CEO delegates bounded goals and changes the team as evidence arrives." },
]

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a href="#top" className="inline-flex items-center gap-2.5 text-[#0a0a0b]" aria-label="Goah home">
      <Image src="/goah-orbital-mark.png" alt="" width={compact ? 28 : 32} height={compact ? 28 : 32} priority />
      <span className={compact ? "text-[15px] font-semibold tracking-[-0.02em]" : "text-[17px] font-semibold tracking-[-0.025em]"}>goah</span>
    </a>
  )
}

export default function Home() {
  return (
    <main id="top" className="min-h-screen overflow-hidden bg-[#f7f7f4] text-[#0a0a0b]">
      <header className="mx-auto flex h-[88px] w-full max-w-[1540px] items-center justify-between px-6 lg:px-10">
        <Brand />
        <nav className="hidden items-center gap-8 text-sm text-black/55 md:flex" aria-label="Primary navigation">
          <a className="transition-colors hover:text-black" href="#why">Why Goah</a>
          <a className="transition-colors hover:text-black" href="#system">System</a>
          <a className="transition-colors hover:text-black" href={npmUrl}>npm</a>
        </nav>
        <Button asChild variant="outline" className="h-10 rounded-full border-black/12 bg-transparent px-4 text-black shadow-none hover:bg-black hover:text-white">
          <a href={githubUrl}><Code2 className="size-4" />GitHub</a>
        </Button>
      </header>

      <section className="relative min-h-[calc(100svh-88px)] overflow-hidden">
        <div className="absolute left-1/2 top-[76%] z-10 size-[220px] -translate-x-1/2 -translate-y-1/2 sm:size-[270px] lg:left-[72%] lg:top-1/2 lg:size-[430px]" aria-hidden="true">
          <BubbleBackground
            interactive
            className="rounded-full border border-white/65 bg-[#e9edff] shadow-[0_30px_90px_rgba(36,71,216,0.16)]"
            colors={{
              first: "36,71,216",
              second: "70,61,210",
              third: "105,121,255",
              fourth: "127,101,222",
              fifth: "190,200,255",
              sixth: "36,71,216",
            }}
          >
            <GradientBackground
              customGradient="radial-gradient(118% 112% at 34% 104%,rgba(29,61,205,0.9) 0%,rgba(88,76,220,0.48) 34%,rgba(168,157,246,0.28) 64%,rgba(235,238,255,0.1) 100%)"
              noisePatternSize={88}
              noisePatternRefreshInterval={4}
              noisePatternAlpha={22}
              noiseIntensity={0.72}
              className="z-10 mix-blend-soft-light opacity-80"
            />
            <div className="relative z-20 grid size-full place-items-center">
              <Image
                src="/goah-orbital-mark.png"
                alt=""
                width={360}
                height={360}
                className="w-[90px] -translate-x-[1.45%] -translate-y-[0.65%] brightness-0 invert drop-shadow-[0_8px_24px_rgba(13,28,95,0.22)] sm:w-[112px] lg:w-[160px]"
                priority
              />
            </div>
          </BubbleBackground>
        </div>

        <div className="relative z-20 mx-auto flex min-h-[calc(100svh-88px)] w-full max-w-[1540px] px-6 pb-6 pt-10 lg:items-center lg:px-10 lg:py-16">
          <div className="flex max-w-[780px] flex-col justify-start">
            <h1 className="max-w-[780px] text-[clamp(2.75rem,4.2vw,4.75rem)] font-medium leading-[0.98] tracking-[-0.035em]">
              <span className="block xl:whitespace-nowrap">Agents handle tasks.</span>
              <span className="block text-black/46 xl:whitespace-nowrap">Goah holds the goal.</span>
            </h1>
            <p className="mt-7 max-w-[620px] text-[17px] leading-7 text-black/62 sm:text-lg sm:leading-8">
              A local-first harness for long-running agent organizations. One CEO agent delegates work while durable memory, schedules, wakes, and mail keep the objective moving across sessions.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button asChild className="h-11 rounded-full bg-[#2447d8] px-5 text-white shadow-none hover:bg-[#1d3bb8]">
                <a href="#start">Start with one goal <ArrowUpRight className="size-4" /></a>
              </Button>
              <Button asChild variant="outline" className="h-11 rounded-full border-black/12 bg-[#f7f7f4]/82 px-5 text-black shadow-none hover:bg-black hover:text-white">
                <a href={githubUrl}>View on GitHub</a>
              </Button>
            </div>
            <p className="mt-6 hidden font-mono text-[10px] uppercase tracking-[0.16em] text-black/42 sm:block">Local-first · SQLite ledger · Apache 2.0</p>
          </div>
        </div>
      </section>

      <section id="why" className="mx-auto max-w-[1320px] px-6 py-32 sm:py-44 lg:px-10 lg:py-52">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#1237ff]">The missing layer</p>
        <h2 className="mt-8 max-w-[1120px] text-balance text-[clamp(2.5rem,5vw,5rem)] font-medium leading-[0.98] tracking-[-0.035em]">
          One conversation on the surface.<br /><span className="text-black/45">A durable organization underneath.</span>
        </h2>
        <div className="mt-14 grid gap-8 border-t border-black/10 pt-8 lg:grid-cols-[1fr_1fr]">
          <p className="max-w-[520px] text-lg leading-8 text-black/62">Give one CEO agent an objective. Goah turns it into an observable goal tree, creates the team behind it, and keeps the next move alive across hours, days, and process restarts.</p>
          <p className="max-w-[520px] text-lg leading-8 text-black/62 lg:justify-self-end">To you, it still feels like one capable agent. Underneath, a Supervisor, Ledger, schedules, durable mail, and short-lived workers operate as one system.</p>
        </div>
        <div className="mt-12 flex flex-col gap-3 sm:flex-row">
          <Button asChild className="h-11 rounded-full bg-[#1237ff] px-5 text-white shadow-none hover:bg-[#0d2ddb]"><a href="#start">Start with one goal <ArrowUpRight className="size-4" /></a></Button>
          <Button asChild variant="outline" className="h-11 rounded-full border-black/12 bg-transparent px-5 text-black shadow-none hover:bg-black hover:text-white"><a href={githubUrl}>View on GitHub</a></Button>
        </div>
      </section>

      <section id="system" className="mx-3 overflow-hidden rounded-[28px] bg-white sm:mx-5 lg:mx-8">
        <div className="mx-auto max-w-[1320px] px-6 py-24 lg:px-10 lg:py-32">
          <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#1237ff]">System, not persona</p>
              <h2 className="mt-6 text-4xl font-medium leading-[1.02] tracking-[-0.035em] sm:text-5xl">One interface.<br />Four durable forces.</h2>
            </div>
            <div className="grid border-t border-black/10 sm:grid-cols-2 sm:border-l">
              {principles.map(({ icon: Icon, name, detail }, index) => (
                <article key={name} className={`min-h-[250px] border-b border-black/10 p-6 sm:p-8 ${index % 2 === 0 ? "sm:border-r" : ""}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#1237ff]">{name}</span>
                    <Icon className="size-4 text-black/32" />
                  </div>
                  <p className="mt-20 max-w-[300px] text-[17px] leading-7 text-black/65">{detail}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1320px] gap-16 px-6 py-32 lg:grid-cols-[.9fr_1.1fr] lg:px-10 lg:py-48">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#1237ff]">Goal observation method</p>
          <h2 className="mt-7 text-4xl font-medium leading-[1] tracking-[-0.035em] sm:text-6xl">Keep the goal.<br /><span className="text-black/45">Keep its definition.</span></h2>
          <p className="mt-9 max-w-[520px] text-lg leading-8 text-black/60">A revenue goal should not wake up tomorrow with a new definition of revenue. Every goal carries a durable, textual protocol for checking reality.</p>
          <ul className="mt-10 space-y-4 text-sm text-black/62">
            {["Numeric or qualitative", "Confirmed by the right authority", "Loaded on every wake", "Completion tied to evidence"].map((item) => (
              <li key={item} className="flex items-center gap-3"><span className="grid size-5 place-items-center rounded-full bg-[#1237ff] text-white"><Check className="size-3" /></span>{item}</li>
            ))}
          </ul>
        </div>
        <div className="self-center overflow-hidden rounded-[24px] border border-black/10 bg-white shadow-[0_22px_70px_rgba(0,0,0,0.05)]">
          <div className="flex items-center justify-between border-b border-black/8 px-5 py-4 font-mono text-[9px] uppercase tracking-[0.14em] text-black/60"><span>revenue-goal.observation.md</span><span>confirmed · r3</span></div>
          <pre tabIndex={0} role="region" aria-label="Example goal observation method" className="overflow-x-auto p-7 font-mono text-[12px] leading-7 text-black/68 sm:p-10"><code>{`Use paid Shopify orders as the fact source.

Net revenue = paid amount - refunds.
Exclude tax and shipping.
Group by Asia/Shanghai calendar month.

Run scripts/revenue-report.ts every 6 hours.
Data older than 12 hours cannot support
a progress or completion judgment.`}</code></pre>
        </div>
      </section>

      <section id="start" className="mx-3 mb-5 overflow-hidden rounded-[28px] bg-[#1237ff] text-white sm:mx-5 lg:mx-8">
        <div className="mx-auto max-w-[1320px] px-6 py-20 text-center sm:py-28 lg:px-10">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/85">Local-first · Apache 2.0</p>
          <h2 className="mx-auto mt-7 max-w-[920px] text-balance text-4xl font-medium leading-[1] tracking-[-0.035em] sm:text-6xl">One objective is enough to begin.</h2>
          <p className="mx-auto mt-7 max-w-[560px] text-lg leading-8 text-white/85">Install the CLI, choose a model, then talk to the CEO. The Supervisor, Ledger, and local runners stay on your machine.</p>
          <div className="mx-auto mt-10 flex max-w-[560px] items-center gap-3 rounded-full bg-white p-1.5 pl-5 text-left font-mono text-xs text-black">
            <span className="text-[#1237ff]">$</span><code className="min-w-0 flex-1 truncate">npm install --save-dev @goah/cli</code><CopyCommand command="npm install --save-dev @goah/cli" theme="light" />
          </div>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild className="h-11 rounded-full bg-white px-5 text-black shadow-none hover:bg-white/90"><a href={`${githubUrl}#quick-start`}>Open quick start <ArrowUpRight className="size-4" /></a></Button>
            <Button asChild variant="ghost" className="h-11 rounded-full px-5 text-white hover:bg-white/12 hover:text-white"><a href={npmUrl}>View on npm</a></Button>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1540px] flex-col gap-6 px-6 py-10 text-sm text-black/65 sm:flex-row sm:items-center sm:justify-between lg:px-10">
        <Brand compact />
        <div className="flex gap-6"><a className="hover:text-black" href={githubUrl}>GitHub</a><a className="hover:text-black" href={npmUrl}>npm</a><a className="hover:text-black" href={`${githubUrl}/blob/main/LICENSE`}>Apache 2.0</a></div>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em]">The goal layer for agents.</span>
      </footer>
    </main>
  )
}
