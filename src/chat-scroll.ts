export const CHAT_SCROLL_FOLLOW_THRESHOLD = 72

export type ChatScrollMetrics = { scrollHeight: number, clientHeight: number, scrollTop: number }

export type ChatScrollState = { atEnd: boolean, showLatestButton: boolean }

export function isAtScrollEnd(
  metrics: ChatScrollMetrics,
  threshold = CHAT_SCROLL_FOLLOW_THRESHOLD,
): boolean {
  if (metrics.scrollHeight <= metrics.clientHeight) return true
  return Math.abs(metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop) <= threshold
}

export class ChatScrollFollow {
  private following = true

  get isFollowing(): boolean {
    return this.following
  }

  reset(): void {
    this.following = true
  }

  sample(metrics: ChatScrollMetrics): ChatScrollState {
    const atEnd = isAtScrollEnd(metrics)
    this.following = atEnd
    return {
      atEnd,
      showLatestButton: !atEnd && metrics.scrollHeight > metrics.clientHeight,
    }
  }
}
