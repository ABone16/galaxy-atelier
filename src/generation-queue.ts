export type GenerationQueueItem<ReferenceImage = File | null> = {
  id: string
  prompt: string
  size: 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
  translationEnabled: boolean
  referenceImage: ReferenceImage
  referenceMode: 'edit' | 'reference'
}

export const MAX_GENERATION_QUEUE = 12

export function enqueueGeneration<T>(
  queue: readonly T[],
  item: T,
  max = MAX_GENERATION_QUEUE,
): readonly T[] | null {
  if (queue.length >= max) return null
  return [...queue, item]
}

export function takeNextGeneration<T>(queue: readonly T[]): { item: T | undefined, rest: readonly T[] } {
  return { item: queue[0], rest: queue.slice(1) }
}

export function enqueueAndTakeNextGeneration<T>(
  queue: readonly T[],
  item: T,
  max = MAX_GENERATION_QUEUE,
): { item: T, rest: readonly T[] } | null {
  const next = enqueueGeneration(queue, item, max)
  if (!next) return null
  const taken = takeNextGeneration(next)
  return taken.item === undefined ? null : { item: taken.item, rest: taken.rest }
}

export function removeQueuedGeneration<T extends { id: string }>(
  queue: readonly T[],
  itemId: string,
): readonly T[] {
  return queue.filter(item => item.id !== itemId)
}
