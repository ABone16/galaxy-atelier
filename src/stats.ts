export function successRate(succeeded: number, failed: number, cancelled: number): string {
  const completed = succeeded + failed - cancelled
  return completed > 0 ? `${Math.round(succeeded / completed * 100)}%` : '—'
}
