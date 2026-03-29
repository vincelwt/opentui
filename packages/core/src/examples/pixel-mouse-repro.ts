#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  BoxRenderable,
  createCliRenderer,
  MouseParser,
  RGBA,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type MouseEvent,
} from "../index.js"

interface MouseProtocolContext {
  mouseUsesPixels: boolean
  mousePixelsConfirmed: boolean
  terminalWidth: number
  terminalHeight: number
  pixelWidth: number
  pixelHeight: number
}

interface ProbeState {
  raw: string
  sgr: string
  manualParse: string
  uiType: string
  uiCell: string
  uiPixel: string
  lastAction: string
}

const contextDir = join(process.cwd(), ".context")
const logPath = join(contextDir, "pixel-mouse-repro.log")

const red = RGBA.fromInts(255, 90, 90)
const white = RGBA.fromInts(235, 235, 235)
const muted = RGBA.fromInts(150, 150, 150)

function escapeSequence(input: string): string {
  return input
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
}

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`
}

function extractSgrMouse(sequence: string): string | null {
  const match = sequence.match(/\x1b\[<(\d+);(\d+);(\d+)([mM])/)
  if (!match) return null
  return `<${match[1]};${match[2]};${match[3]}${match[4]}`
}

function buildProtocolContext(renderer: CliRenderer): MouseProtocolContext {
  return {
    mouseUsesPixels: true,
    mousePixelsConfirmed: false,
    terminalWidth: renderer.terminalWidth,
    terminalHeight: renderer.terminalHeight,
    pixelWidth: renderer.resolution?.width ?? 0,
    pixelHeight: renderer.resolution?.height ?? 0,
  }
}

function writePixelMouseHandshake(): void {
  process.stdout.write("\x1b[?1005l\x1b[?1015l\x1b[?1006h\x1b[?1000l\x1b[?1002l\x1b[?1003h\x1b[?1016h")
}

function appendLog(label: string, value: string): void {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${label} ${escapeSequence(value)}\n`)
}

async function main() {
  mkdirSync(contextDir, { recursive: true })
  writeFileSync(logPath, "")

  const disableKittyKeyboard = process.env.OTUI_DISABLE_KITTY_KEYBOARD === "1"
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    enableMouseMovement: true,
    backgroundColor: "#000000",
    useKittyKeyboard: disableKittyKeyboard ? null : undefined,
  })

  const parser = new MouseParser()
  const state: ProbeState = {
    raw: "-",
    sgr: "-",
    manualParse: "-",
    uiType: "-",
    uiCell: "-",
    uiPixel: "-",
    lastAction: "startup",
  }

  const container = new BoxRenderable(renderer, {
    id: "pixel-mouse-repro",
    flexDirection: "column",
    flexGrow: 1,
    paddingTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: RGBA.fromInts(17, 17, 17),
  })
  renderer.root.add(container)

  const lines = Array.from({ length: 12 }, (_, index) => new TextRenderable(renderer, {
    id: `probe-line-${index}`,
    content: "",
    fg: index >= 5 && index <= 9 ? red : white,
    attributes: index === 0 ? TextAttributes.BOLD : 0,
  }))
  for (const line of lines) {
    container.add(line)
  }

  const probeBox = new BoxRenderable(renderer, {
    id: "probe-box",
    flexGrow: 1,
    marginTop: 1,
    border: true,
    borderColor: "#ff4d4d",
    backgroundColor: RGBA.fromInts(34, 9, 9),
  })
  container.add(probeBox)

  const boxLabel = new TextRenderable(renderer, {
    id: "probe-box-label",
    content: "Move inside this box. Press p to resend 1003/1006/1016. Press q to quit.",
    fg: RGBA.fromInts(255, 190, 190),
  })
  probeBox.add(boxLabel)

  function renderState(): void {
    const resolution = renderer.resolution
      ? `${renderer.resolution.width}x${renderer.resolution.height}`
      : "?"

    lines[0]!.content = "OpenTUI Pixel Mouse Repro"
    lines[1]!.content = `terminal=${renderer.terminalWidth}x${renderer.terminalHeight} resolution=${resolution}`
    lines[2]!.content = `kittyKeyboard=${renderer.useKittyKeyboard ? "on" : "off"} sgrPixels=${renderer.capabilities?.sgr_pixels ? "yes" : "no"}`
    lines[3]!.content = `lastAction=${state.lastAction}`
    lines[4]!.content = ""
    lines[5]!.content = `raw=${state.raw}`
    lines[6]!.content = `sgr=${state.sgr}`
    lines[7]!.content = `manual=${state.manualParse}`
    lines[8]!.content = `ui type=${state.uiType}`
    lines[9]!.content = `ui cell=${state.uiCell}`
    lines[10]!.content = `ui pixel=${state.uiPixel}`
    lines[11]!.content = `log=${logPath}`

    lines[1]!.fg = muted
    lines[2]!.fg = muted
    lines[3]!.fg = muted
    lines[4]!.fg = white
    lines[11]!.fg = muted
  }

  function updateUiState(event: MouseEvent): void {
    state.uiType = event.type
    state.uiCell = `${event.x},${event.y}`
    state.uiPixel = event.pixelX !== undefined && event.pixelY !== undefined
      ? `${event.pixelX},${event.pixelY}`
      : "-"
    appendLog("ui", `type=${event.type} cell=${event.x},${event.y} pixel=${state.uiPixel}`)
    renderState()
  }

  probeBox.onMouseMove = updateUiState
  probeBox.onMouseDown = updateUiState
  probeBox.onMouseDrag = updateUiState

  const onStdin = (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const sequence = data.toString("latin1")
    appendLog("stdin", sequence)

    const sgr = extractSgrMouse(sequence)
    const isPixelResolution = /\x1b\[4;\d+;\d+t/.test(sequence)
    if (!sgr && !isPixelResolution) {
      return
    }

    state.raw = truncate(escapeSequence(sequence))
    state.sgr = sgr ?? "-"

    const parsed = parser.parseAllMouseEvents(Buffer.from(sequence, "latin1"), buildProtocolContext(renderer))
    state.manualParse = parsed.length === 0
      ? "non-mouse"
      : truncate(parsed.map((event) => (
        `type=${event.type} cell=${event.x},${event.y} px=${event.pixelX ?? "-"},${event.pixelY ?? "-"}`
      )).join(" | "))

    renderState()
  }

  process.stdin.on("data", onStdin)

  renderer.on("capabilities", () => {
    state.lastAction = `capabilities sgrPixels=${renderer.capabilities?.sgr_pixels ? "yes" : "no"}`
    renderState()
  })

  renderer.on("resize", () => {
    state.lastAction = "resize"
    renderState()
  })

  renderer.addInputHandler((sequence) => {
    if (sequence === "p") {
      state.lastAction = "manual-rearm"
      appendLog("action", "manual-rearm")
      writePixelMouseHandshake()
      renderState()
      return true
    }

    if (sequence === "q") {
      state.lastAction = "quit"
      appendLog("action", "quit")
      process.stdin.off("data", onStdin)
      renderer.destroy()
      return true
    }

    return false
  })

  renderState()
  renderer.start()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
