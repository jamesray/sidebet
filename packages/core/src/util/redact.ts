const PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    name: 'assigned-secret',
    re: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*["']?([^\s"']{8,})["']?/gi,
  },
]

export interface RedactionResult {
  text: string
  count: number
  kinds: string[]
}

export const redactSecrets = (input: string): RedactionResult => {
  let text = input
  let count = 0
  const kinds = new Set<string>()
  for (const { name, re } of PATTERNS) {
    text = text.replace(re, (_match: string, group1?: string) => {
      count += 1
      kinds.add(name)
      if (name === 'assigned-secret' && typeof group1 === 'string') return `${group1}=[REDACTED]`
      return '[REDACTED]'
    })
  }
  return { text, count, kinds: [...kinds] }
}

export const containsSecret = (input: string): boolean => redactSecrets(input).count > 0
