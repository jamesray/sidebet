/** Cheap, deterministic token estimate (~4 chars per token). Labelled as an estimate everywhere. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export const truncateToTokens = (
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } => {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n[... truncated by Sidebet context budget]`,
    truncated: true,
  }
}
