export type MouseEventType = "down" | "up" | "move" | "drag" | "drag-end" | "drop" | "over" | "out" | "scroll"

export interface ScrollInfo {
  direction: "up" | "down" | "left" | "right"
  delta: number
}

export interface MouseParserContext {
  mouseUsesPixels?: boolean
  mousePixelsConfirmed?: boolean
  terminalWidth?: number
  terminalHeight?: number
  pixelWidth?: number
  pixelHeight?: number
}

export type RawMouseEvent = {
  type: MouseEventType
  button: number
  x: number
  y: number
  pixelX?: number
  pixelY?: number
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean }
  scroll?: ScrollInfo
}

type ParsedMouseSequence = {
  event: RawMouseEvent
  consumed: number
}

export class MouseParser {
  private mouseButtonsPressed = new Set<number>()

  private static readonly SCROLL_DIRECTIONS: Record<number, "up" | "down" | "left" | "right"> = {
    0: "up",
    1: "down",
    2: "left",
    3: "right",
  }

  public reset(): void {
    this.mouseButtonsPressed.clear()
  }

  // Preserve raw byte values so X10 payload bytes >= 0x80 remain intact.
  // SGR sequences are ASCII digits + separators and are unaffected either way.
  private decodeInput(data: Buffer | Uint8Array): string {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    return buf.toString("latin1")
  }

  private projectPixelToCell(pixel: number, pixelExtent: number, cellCount: number): number {
    if (cellCount <= 1) {
      return 0
    }

    if (!(pixelExtent > 1)) {
      return Math.max(Math.floor(pixel), 0)
    }

    const ratio = Math.max(0, Math.min(pixel / Math.max(pixelExtent - 1, 1), 1))
    return Math.floor(ratio * Math.max(cellCount - 1, 0))
  }

  public parseMouseEvent(data: Buffer | Uint8Array, context?: MouseParserContext): RawMouseEvent | null {
    const str = this.decodeInput(data)
    const parsed = this.parseMouseSequenceAt(str, 0, context)
    return parsed?.event ?? null
  }

  public parseAllMouseEvents(data: Buffer | Uint8Array, context?: MouseParserContext): RawMouseEvent[] {
    const str = this.decodeInput(data)
    const events: RawMouseEvent[] = []
    let offset = 0

    while (offset < str.length) {
      const parsed = this.parseMouseSequenceAt(str, offset, context)
      if (!parsed) {
        // Stop at the first non-mouse sequence. Callers can decide whether to
        // route any remaining data through keyboard/terminal input handling.
        break
      }

      events.push(parsed.event)
      offset += parsed.consumed
    }

    return events
  }

  private parseMouseSequenceAt(str: string, offset: number, context?: MouseParserContext): ParsedMouseSequence | null {
    if (!str.startsWith("\x1b[", offset)) return null
    const introducer = str[offset + 2]

    if (introducer === "<") {
      return this.parseSgrSequence(str, offset, context)
    }

    if (introducer === "M") {
      return this.parseBasicSequence(str, offset)
    }

    return null
  }

  private parseSgrSequence(str: string, offset: number, context?: MouseParserContext): ParsedMouseSequence | null {
    let index = offset + 3
    const values = [0, 0, 0]
    let part = 0
    let hasDigit = false

    while (index < str.length) {
      const char = str[index]
      const charCode = str.charCodeAt(index)

      if (charCode >= 48 && charCode <= 57) {
        hasDigit = true
        values[part] = values[part]! * 10 + (charCode - 48)
        index++
        continue
      }

      switch (char) {
        case ";": {
          if (!hasDigit || part >= 2) return null
          part++
          hasDigit = false
          index++
          break
        }
        case "M":
        case "m": {
          if (!hasDigit || part !== 2) return null

          return {
            event: this.decodeSgrEvent(values[0]!, values[1]!, values[2]!, char, context),
            consumed: index - offset + 1,
          }
        }
        default:
          return null
      }
    }

    return null
  }

  private parseBasicSequence(str: string, offset: number): ParsedMouseSequence | null {
    // ESC [ M + 3 bytes
    if (offset + 6 > str.length) return null

    const buttonByte = str.charCodeAt(offset + 3) - 32
    // Convert from 1-based to 0-based
    const x = str.charCodeAt(offset + 4) - 33
    const y = str.charCodeAt(offset + 5) - 33

    return {
      event: this.decodeBasicEvent(buttonByte, x, y),
      consumed: 6,
    }
  }

  private decodeSgrEvent(
    rawButtonCode: number,
    wireX: number,
    wireY: number,
    pressRelease: "M" | "m",
    context?: MouseParserContext,
  ): RawMouseEvent {
    const button = rawButtonCode & 3
    const isScroll = (rawButtonCode & 64) !== 0
    const scrollDirection = !isScroll ? undefined : MouseParser.SCROLL_DIRECTIONS[button]

    const isMotion = (rawButtonCode & 32) !== 0
    const modifiers = {
      shift: (rawButtonCode & 4) !== 0,
      alt: (rawButtonCode & 8) !== 0,
      ctrl: (rawButtonCode & 16) !== 0,
    }

    let type: MouseEventType
    let scrollInfo: ScrollInfo | undefined

    if (isMotion) {
      const isDragging = this.mouseButtonsPressed.size > 0

      if (button === 3) {
        type = "move"
      } else if (isDragging) {
        type = "drag"
      } else {
        type = "move"
      }
    } else if (isScroll && pressRelease === "M") {
      type = "scroll"
      scrollInfo = {
        direction: scrollDirection!,
        delta: 1,
      }
    } else {
      type = pressRelease === "M" ? "down" : "up"

      if (type === "down" && button !== 3) {
        this.mouseButtonsPressed.add(button)
      } else if (type === "up") {
        this.mouseButtonsPressed.clear()
      }
    }

    const pixelModeRequested = context?.mouseUsesPixels === true
    const pixelModeConfirmed = context?.mousePixelsConfirmed === true
    const pixelModeDetected = pixelModeRequested && (
      pixelModeConfirmed
      || wireX > (context?.terminalWidth ?? Number.POSITIVE_INFINITY)
      || wireY > (context?.terminalHeight ?? Number.POSITIVE_INFINITY)
    )
    const pixelX = pixelModeDetected ? Math.max(wireX - 1, 0) : undefined
    const pixelY = pixelModeDetected ? Math.max(wireY - 1, 0) : undefined

    return {
      type,
      button: button === 3 ? 0 : button,
      x: pixelModeDetected && pixelX !== undefined
        ? this.projectPixelToCell(pixelX, context?.pixelWidth ?? 0, context?.terminalWidth ?? 0)
        : wireX - 1,
      y: pixelModeDetected && pixelY !== undefined
        ? this.projectPixelToCell(pixelY, context?.pixelHeight ?? 0, context?.terminalHeight ?? 0)
        : wireY - 1,
      pixelX,
      pixelY,
      modifiers,
      scroll: scrollInfo,
    }
  }

  private decodeBasicEvent(buttonByte: number, x: number, y: number): RawMouseEvent {
    const button = buttonByte & 3
    const isScroll = (buttonByte & 64) !== 0
    const isMotion = (buttonByte & 32) !== 0
    const scrollDirection = !isScroll ? undefined : MouseParser.SCROLL_DIRECTIONS[button]

    const modifiers = {
      shift: (buttonByte & 4) !== 0,
      alt: (buttonByte & 8) !== 0,
      ctrl: (buttonByte & 16) !== 0,
    }

    let type: MouseEventType
    let actualButton: number
    let scrollInfo: ScrollInfo | undefined

    if (isMotion) {
      type = "move"
      actualButton = button === 3 ? -1 : button
    } else if (isScroll) {
      type = "scroll"
      actualButton = 0
      scrollInfo = {
        direction: scrollDirection!,
        delta: 1,
      }
    } else {
      type = button === 3 ? "up" : "down"
      actualButton = button === 3 ? 0 : button
    }

    return {
      type,
      button: actualButton,
      x,
      y,
      modifiers,
      scroll: scrollInfo,
    }
  }
}
