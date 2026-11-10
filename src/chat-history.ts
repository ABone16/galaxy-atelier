import type { Message } from './api'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareMessages(left: Message, right: Message): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id)
}

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map(message => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort(compareMessages)
}

export function preserveScrollAnchor(scrollTop: number, scrollHeightBefore: number, scrollHeightAfter: number): number {
  return Math.max(0, scrollTop + scrollHeightAfter - scrollHeightBefore)
}
