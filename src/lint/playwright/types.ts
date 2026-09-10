export interface VisualBug {
  rule: string
  description: string
  severity: "critical" | "major" | "minor"
  element?: string
}

export interface VisualLintResult {
  passed: boolean
  bugs: VisualBug[]
}
