export const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const lo = sorted[mid - 1]
  const hi = sorted[mid]
  if (hi === undefined) return undefined
  return sorted.length % 2 === 1 ? hi : lo === undefined ? hi : (lo + hi) / 2
}
