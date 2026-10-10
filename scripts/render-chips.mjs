// Writes docs/assets/chip-<name>.svg for every palette, from the same generator the CLI and web UI use.
import { mkdirSync, writeFileSync } from 'node:fs'
import { CHIP_PALETTES, renderChipSvg } from '../apps/cli/dist/style/chip.js'

mkdirSync('docs/assets', { recursive: true })
for (const p of Object.values(CHIP_PALETTES))
  writeFileSync(`docs/assets/chip-${p.name}.svg`, `${renderChipSvg(p, { scale: 4 })}\n`)
console.log(`wrote ${Object.keys(CHIP_PALETTES).length} chips to docs/assets/`)
