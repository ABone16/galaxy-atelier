import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  Clock3,
  Coins,
  Download,
  Eye,
  EyeOff,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  Languages,
  LoaderCircle,
  LockKeyhole,
  List,
  LogOut,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Plus,
  Pencil,
  RefreshCw,
  Search,
  ScrollText,
  Send,
  Settings2,
  Shield,
  Sparkles,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { api, type Account, type AdminStats, type AuditLog, type Message, type MessagePage, type ModelUsage, type ProviderSettings, type QueueItem, type SessionSummary, type TrafficBucket, type Usage, type User } from './api'
import { ChatScrollFollow } from './chat-scroll'
import { mergeMessages, preserveScrollAnchor } from './chat-history'
import type { GenerationQueueItem } from './generation-queue'
import { successRate } from './stats'
import { detectBrowserLanguage, installLocalization, type Language } from './i18n'

type Page = 'studio' | 'usage' | 'stats' | 'users' | 'providers' | 'logs'
type Size = 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
const defaultDirectSize: Exclude<Size, 'auto'> = '1536x1024'
type ReferenceMode = 'edit' | 'reference'
type ThemeId = 'system' | 'atelier' | 'paper' | 'ocean' | 'sunset' | 'midnight' | 'forest' | 'plum' | 'graphite' | 'galaxy'
type QueuedGeneration = GenerationQueueItem<File | null> & {
  persisted?: boolean
  hasReference?: boolean
  referenceImageBytes?: number
}

type OptimisticUserMessage = {
  id: string
  sessionId: string
  content: string
  imageMode: ReferenceMode | 'generation'
  referenceImageBytes: number
  message: Message
}

const pageLabels: Record<Page, string> = {
  studio: 'Image Studio',
  usage: 'My Usage',
  stats: 'Overview',
  users: 'Account management',
  providers: 'Models & keys',
  logs: 'Audit logs',
}

const themeOptions: Array<{ id: ThemeId, label: string, mode: 'light' | 'dark' | 'system' }> = [
  { id: 'system', label: 'Follow system', mode: 'system' },
  { id: 'atelier', label: 'Galaxy Teal', mode: 'light' },
  { id: 'paper', label: 'Paper', mode: 'light' },
  { id: 'ocean', label: 'Ocean', mode: 'light' },
  { id: 'sunset', label: 'Sunset', mode: 'light' },
  { id: 'midnight', label: 'Midnight', mode: 'dark' },
  { id: 'forest', label: 'Forest', mode: 'dark' },
  { id: 'plum', label: 'Plum', mode: 'dark' },
  { id: 'graphite', label: 'Graphite', mode: 'dark' },
  { id: 'galaxy', label: 'Galaxy', mode: 'dark' },
]

function isThemeId(value: string | null): value is ThemeId {
  return themeOptions.some(option => option.id === value)
}

function readStoredLanguage(): Language | null {
  const stored = window.localStorage.getItem('galaxy-language') ?? window.localStorage.getItem('atelier-language')
  return stored === 'zh' || stored === 'en' ? stored : null
}

function imageDownloadName(message: Message): string {
  const base = message.imageName?.trim() || 'Generate image'
  const safe = base.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${safe || 'Generate image'}.png`
}

function money(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(4)}`
}

function costBreakdown(translation: number | null | undefined, imageToken: number | null | undefined, imageRequest: number | null | undefined, unknown: number | undefined, includeUnknown = false): string {
  if (translation === null || imageToken === null || imageRequest === null) {
    return `Unclassified history ${money(unknown)}`
  }
  if (translation === undefined || imageToken === undefined || imageRequest === undefined) return ''
  const parts = `Translation ${money(translation)} · Image Token ${money(imageToken)} · Request ${money(imageRequest)}`
  return includeUnknown && unknown ? `${parts} · Unclassified history ${money(unknown)}` : parts
}

function number(value: number | undefined): string {
  const locale = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en-US'
  return new Intl.NumberFormat(locale).format(value ?? 0)
}

function sizeLabel(value: Size): string {
  if (value === 'auto') return 'Model decides'
  if (value === '1024x1024') return 'Square'
  if (value === '1024x1536') return 'Portrait'
  return 'Landscape'
}

function timeLabel(value: string | null | undefined): string {
  if (!value) return 'Never logged in'
  const locale = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en-US'
  return new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function durationLabel(value: number | null | undefined): string {
  const seconds = Math.max(0, Math.round((value ?? 0) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m${remainder}s` : `${minutes}minutes`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function readImageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unable to read the reference image'))
    reader.onerror = () => reject(new Error('Unable to read the reference image'))
    reader.readAsDataURL(file)
  })
}

const imageFileExtensions = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i

function isPotentialImageFile(file: File): boolean {
  return file.type.startsWith('image/') || imageFileExtensions.test(file.name)
}

function detectImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6) {
    const signature = new TextDecoder().decode(bytes.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return undefined
}

async function decodeImage(file: Blob): Promise<{ source: CanvasImageSource, width: number, height: number, close?: () => void }> {
  if ('createImageBitmap' in window) {
    const bitmap = await window.createImageBitmap(file)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('image-decode-failed'))
      element.src = url
    })
    return { source: image, width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function normalizeImageFile(file: File): Promise<File> {
  if (!isPotentialImageFile(file)) throw new Error('Please choose an image file')
  if (file.size > 10 * 1024 * 1024) throw new Error('Reference image must not exceed 10 MiB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const detectedType = detectImageType(bytes)
  const sourceBlob = new Blob([bytes], { type: detectedType ?? (file.type || 'application/octet-stream') })
  let decoded: Awaited<ReturnType<typeof decodeImage>>
  try {
    decoded = await decodeImage(sourceBlob)
  } catch {
    throw new Error('Unable to read the image. Confirm the file is not corrupted and that your browser supports this format.')
  }
  if (!decoded.width || !decoded.height || decoded.width > 16_384 || decoded.height > 16_384) {
    decoded.close?.()
    throw new Error('Reference image dimensions are invalid or too large')
  }
  const canvas = document.createElement('canvas')
  canvas.width = decoded.width
  canvas.height = decoded.height
  const context = canvas.getContext('2d')
  if (!context) {
    decoded.close?.()
    throw new Error('This browser does not support image conversion')
  }
  context.drawImage(decoded.source, 0, 0)
  decoded.close?.()
  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('image-encode-failed')), 'image/png')
  })
  if (pngBlob.size > 10 * 1024 * 1024) throw new Error('Converted PNG exceeds 10 MiB')
  const stem = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'reference-image'
  return new File([pngBlob], `${stem}.png`, { type: 'image/png', lastModified: file.lastModified || Date.now() })
}

type SelectorOption<T extends string> = { id: T, label: string }

const sizeOptions: SelectorOption<Size>[] = [
  { id: 'auto', label: 'Model decides' },
  { id: '1024x1024', label: 'Square' },
  { id: '1024x1536', label: 'Portrait' },
  { id: '1536x1024', label: 'Landscape' },
]

function SelectorPopover<T extends string>({
  id,
  className,
  title,
  ariaLabel,
  icon,
  value,
  options,
  onChange,
  disabled = false,
  renderOptionPrefix,
  renderTriggerPrefix,
}: {
  id: string
  className: string
  title: string
  ariaLabel: string
  icon: ReactNode
  value: T
  options: SelectorOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  renderOptionPrefix?: (option: SelectorOption<T>) => ReactNode
  renderTriggerPrefix?: (option: SelectorOption<T>) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const currentIndex = Math.max(0, options.findIndex(option => option.id === value))
  const [highlightedIndex, setHighlightedIndex] = useState(currentIndex)
  const selectedOption = options[currentIndex] ?? options[0]
  const menuId = `${id}-menu`

  useEffect(() => {
    if (!open) return
    setHighlightedIndex(currentIndex)
    optionRefs.current[currentIndex]?.focus()
    function dismiss(event: globalThis.PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [currentIndex, open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  function focusOption(index: number): void {
    const nextIndex = (index + options.length) % options.length
    setHighlightedIndex(nextIndex)
    optionRefs.current[nextIndex]?.focus()
  }

  function selectOption(option: SelectorOption<T>): void {
    onChange(option.id)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
      setHighlightedIndex(currentIndex)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setHighlightedIndex(options.length - 1)
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const option = options[index]
      if (option) selectOption(option)
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className={`selector-control ${className}`} data-open={open} data-disabled={disabled}>
      <button
        ref={triggerRef}
        type="button"
        className="selector-trigger"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(value => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        {icon}
        {selectedOption && renderTriggerPrefix?.(selectedOption)}
        <span className="selector-trigger-label">{selectedOption?.label}</span>
        <ChevronDown className="selector-chevron" size={13} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="selector-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => {
            const selected = option.id === value
            const highlighted = index === highlightedIndex
            return (
              <button
                key={option.id}
                ref={element => { optionRefs.current[index] = element }}
                type="button"
                role="option"
                className="selector-option"
                data-selected={selected}
                data-highlighted={highlighted}
                aria-selected={selected}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectOption(option)}
                onKeyDown={event => handleOptionKeyDown(event, index)}
              >
                {renderOptionPrefix?.(option)}
                <span className="selector-option-label">{option.label}</span>
                {selected && <Check className="selector-option-check" size={14} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function themeSwatch(option: SelectorOption<ThemeId>, trigger = false): ReactNode {
  return <span className={`theme-swatch theme-swatch-${option.id}${trigger ? ' selector-trigger-swatch' : ''}`} aria-hidden="true" />
}

function ThemeSwitcher({ theme, onChange }: { theme: ThemeId, onChange: (theme: ThemeId) => void }) {
  return (
    <SelectorPopover
      id="theme-selector"
      className="theme-control"
      title="Change theme"
      ariaLabel="Interface theme"
      icon={<Palette size={14} aria-hidden="true" />}
      value={theme}
      options={themeOptions}
      onChange={onChange}
      renderOptionPrefix={option => themeSwatch(option)}
      renderTriggerPrefix={option => themeSwatch(option, true)}
    />
  )
}

const languageOptions: SelectorOption<Language>[] = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: 'Chinese' },
]

function LanguageSwitcher({ language, onChange }: { language: Language, onChange: (language: Language) => void }) {
  return (
    <SelectorPopover
      id="language-selector"
      className="language-control"
      title="Change language"
      ariaLabel="Language"
      icon={<Languages size={14} aria-hidden="true" />}
      value={language}
      options={languageOptions}
      onChange={onChange}
    />
  )
}

export function App() {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  const [page, setPage] = useState<Page>('studio')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionSearchDraft, setSessionSearchDraft] = useState('')
  const [sessionSearchQuery, setSessionSearchQuery] = useState('')
  const [sessionSearchMatches, setSessionSearchMatches] = useState<{ query: string, archived: boolean, ids: string[] } | null>(null)
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false)
  const [sessionSearchError, setSessionSearchError] = useState(false)
  const [sessionSearchVersion, setSessionSearchVersion] = useState(0)
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [editingSession, setEditingSession] = useState<string | null>(null)
  const [sessionTitleDraft, setSessionTitleDraft] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [messagePage, setMessagePage] = useState({ hasMore: false, nextCursor: null as string | null })
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [runningSessions, setRunningSessions] = useState<Record<string, boolean>>({})
  const [queuedGenerations, setQueuedGenerations] = useState<Record<string, QueuedGeneration[]>>({})
  const [loadingEditImageId, setLoadingEditImageId] = useState<string | null>(null)
  const [cancelingSessions, setCancelingSessions] = useState<Record<string, boolean>>({})
  const [pendingPrompts, setPendingPrompts] = useState<Record<string, string>>({})
  const [pendingTranslationEnabled, setPendingTranslationEnabled] = useState<Record<string, boolean>>({})
  const [prompt, setPrompt] = useState('')
  const [translationEnabled, setTranslationEnabled] = useState(true)
  const [referenceImage, setReferenceImage] = useState<File | null>(null)
  const [referenceMode, setReferenceMode] = useState<'edit' | 'reference'>('edit')
  const [size, setSize] = useState<Size>('auto')
  const [imagePreview, setImagePreview] = useState<{ url: string, alt: string, title: string } | null>(null)
  const [languageAuto, setLanguageAuto] = useState(() => readStoredLanguage() === null)
  const [language, setLanguage] = useState<Language>(() => readStoredLanguage() ?? detectBrowserLanguage())
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 720)
  const [toast, setToast] = useState('')
  const [theme, setTheme] = useState<ThemeId>(() => {
    const stored = window.localStorage.getItem('galaxy-theme') ?? window.localStorage.getItem('atelier-theme')
    return isThemeId(stored) ? stored : 'system'
  })
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const sessionSearchInputRef = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<Message[]>([])
  const optimisticUserMessagesRef = useRef<OptimisticUserMessage[]>([])
  const messageSessionRef = useRef<string | null>(activeSession)
  const skipSessionLoad = useRef<string | null>(null)
  const activeGenerationSession = useRef<string | null>(null)
  const activeSessionRef = useRef(activeSession)
  const showArchivedRef = useRef(showArchived)
  const runningSessionsRef = useRef<Record<string, boolean>>({})
  const queuedGenerationsRef = useRef<Record<string, QueuedGeneration[]>>({})
  const drainingSessions = useRef(new Set<string>())
  const localGenerationSessions = useRef(new Set<string>())
  const pausedGenerationSessions = useRef(new Set<string>())
  const cancelingSessionsRef = useRef<Record<string, boolean>>({})

  useLayoutEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const selected = themeOptions.find(option => option.id === theme)
    const applyTheme = () => {
      root.dataset.theme = theme
      root.style.colorScheme = theme === 'system'
        ? (media.matches ? 'dark' : 'light')
        : (selected?.mode === 'dark' ? 'dark' : 'light')
    }
    applyTheme()
    window.localStorage.setItem('galaxy-theme', theme)
    if (theme !== 'system') return
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [theme])

  useEffect(() => {
    if (!languageAuto) window.localStorage.setItem('galaxy-language', language)
    installLocalization(language)
  }, [language, languageAuto])

  useEffect(() => {
    if (!languageAuto) return
    function syncBrowserLanguage() {
      const detected = detectBrowserLanguage()
      setLanguage(current => current === detected ? current : detected)
    }
    window.addEventListener('languagechange', syncBrowserLanguage)
    return () => window.removeEventListener('languagechange', syncBrowserLanguage)
  }, [languageAuto])

  function handleLanguageChange(next: Language): void {
    setLanguageAuto(false)
    setLanguage(next)
  }

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  function markSessionRunning(sessionId: string, running: boolean): void {
    const next = { ...runningSessionsRef.current }
    if (running) next[sessionId] = true
    else delete next[sessionId]
    runningSessionsRef.current = next
    setRunningSessions(next)
  }

  function applyMessagePage(page: MessagePage, replace = false, updatePaging = true): Message[] {
    const sessionId = activeSessionRef.current
    const source = replace || messageSessionRef.current !== sessionId ? [] : messagesRef.current
    const optimisticForSession = optimisticUserMessagesRef.current.filter(item => item.sessionId === sessionId)
    const resolvedIds = new Set<string>()
    for (const incoming of page.items) {
      if (incoming.role !== 'user') continue
      const match = optimisticForSession.find(item =>
        !resolvedIds.has(item.id)
        && item.content === incoming.content
        && item.imageMode === (incoming.imageMode ?? 'generation')
        && item.referenceImageBytes === (incoming.referenceImageBytes ?? 0),
      )
      if (match) resolvedIds.add(match.id)
    }
    if (resolvedIds.size) {
      optimisticUserMessagesRef.current = optimisticUserMessagesRef.current.filter(item => !resolvedIds.has(item.id))
    }
    const remainingOptimistic = optimisticForSession.filter(item => !resolvedIds.has(item.id)).map(item => item.message)
    const merged = mergeMessages(source, page.items).filter(message => !resolvedIds.has(message.id))
    const next = mergeMessages(merged, remainingOptimistic)
    messagesRef.current = next
    messageSessionRef.current = sessionId
    setMessages(next)
    if (updatePaging) setMessagePage({ hasMore: page.hasMore, nextCursor: page.nextCursor })
    return next
  }

  function clearMessages(): void {
    messagesRef.current = []
    messageSessionRef.current = activeSessionRef.current
    setMessages([])
    setMessagePage({ hasMore: false, nextCursor: null })
  }

  function addOptimisticUserMessage(
    sessionId: string,
    content: string,
    inputImageUrl: string | undefined,
    imageMode: ReferenceMode | 'generation',
    referenceImageBytes: number,
  ): void {
    const id = `optimistic-${crypto.randomUUID()}`
    const message: Message = {
      id,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      imageMode,
      referenceImageBytes,
      ...(inputImageUrl ? { inputImageUrl } : {}),
    }
    optimisticUserMessagesRef.current = [
      ...optimisticUserMessagesRef.current,
      { id, sessionId, content, imageMode, referenceImageBytes, message },
    ]
    const currentSession = activeSessionRef.current
    if (currentSession !== sessionId) return
    const next = mergeMessages(messagesRef.current, [message])
    messagesRef.current = next
    messageSessionRef.current = sessionId
    setMessages(next)
  }

  function markSessionCanceling(sessionId: string, canceling: boolean): void {
    const next = { ...cancelingSessionsRef.current }
    if (canceling) next[sessionId] = true
    else delete next[sessionId]
    cancelingSessionsRef.current = next
    setCancelingSessions(next)
  }

  function setSessionQueue(sessionId: string, items: QueuedGeneration[]): void {
    const next = { ...queuedGenerationsRef.current }
    if (items.length) next[sessionId] = items
    else delete next[sessionId]
    queuedGenerationsRef.current = next
    setQueuedGenerations(next)
  }

  function applyQueueSnapshot(sessionId: string, snapshot: { items: QueueItem[], paused: boolean }): QueuedGeneration[] {
    const items: QueuedGeneration[] = snapshot.items.map(item => ({
      id: item.id,
      prompt: item.prompt,
      size: item.size,
      translationEnabled: item.translationEnabled,
      referenceImage: null,
      referenceMode: item.referenceMode,
      persisted: true,
      hasReference: item.hasReference,
      referenceImageBytes: item.referenceImageBytes,
    }))
    setSessionQueue(sessionId, items)
    if (snapshot.paused) pausedGenerationSessions.current.add(sessionId)
    else pausedGenerationSessions.current.delete(sessionId)
    return items
  }

  async function refreshQueue(sessionId: string): Promise<QueuedGeneration[]> {
    return applyQueueSnapshot(sessionId, await api.queue(sessionId))
  }

  async function drainQueue(sessionId: string): Promise<void> {
    if (runningSessionsRef.current[sessionId] || pausedGenerationSessions.current.has(sessionId)
      || drainingSessions.current.has(sessionId)) return
    drainingSessions.current.add(sessionId)
    try {
      const snapshot = await api.queue(sessionId)
      const items = applyQueueSnapshot(sessionId, snapshot)
      if (snapshot.paused || !items.length || runningSessionsRef.current[sessionId]) return
      const next = items[0]
      void runGeneration(sessionId, next)
    } catch (error) {
      setToast(errorText(error))
    } finally {
      drainingSessions.current.delete(sessionId)
    }
  }

  useEffect(() => {
    api.me()
      .then(({ user: current }) => setUser(current))
      .catch(() => setUser(null))
      .finally(() => setAuthReady(true))
  }, [])

  useEffect(() => {
    if (!user) return
    const controller = new AbortController()
    api.sessions(showArchived, '', controller.signal)
      .then(items => {
        if (controller.signal.aborted) return
        setSessions(items)
        setActiveSession(current => current ?? items[0]?.id ?? null)
      })
      .catch(error => { if (!controller.signal.aborted) setToast(errorText(error)) })
    return () => controller.abort()
  }, [user, showArchived])

  useEffect(() => {
    const timer = window.setTimeout(() => setSessionSearchQuery(sessionSearchDraft.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [sessionSearchDraft])

  useEffect(() => {
    const query = sessionSearchQuery
    if (!user || !query) {
      setSessionSearchMatches(null)
      setSessionSearchLoading(false)
      setSessionSearchError(false)
      return
    }
    const controller = new AbortController()
    setSessionSearchLoading(true)
    setSessionSearchError(false)
    api.sessions(showArchived, query, controller.signal)
      .then(items => {
        if (!controller.signal.aborted) {
          setSessionSearchMatches({ query, archived: showArchived, ids: items.map(item => item.id) })
        }
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setSessionSearchMatches(null)
        setSessionSearchError(true)
        setToast(errorText(error))
      })
      .finally(() => { if (!controller.signal.aborted) setSessionSearchLoading(false) })
    return () => controller.abort()
  }, [user, showArchived, sessionSearchQuery, sessionSearchVersion])

  useEffect(() => {
    if (sessionSearchOpen) sessionSearchInputRef.current?.focus()
  }, [sessionSearchOpen])

  useEffect(() => {
    if (!user || !activeSession) {
      clearMessages()
      return
    }
    if (skipSessionLoad.current === activeSession) {
      skipSessionLoad.current = null
      clearMessages()
      setLoadingMessages(false)
      return
    }
    setLoadingMessages(true)
    let current = true
    Promise.all([api.messages(activeSession, { limit: 50 }), api.queue(activeSession)])
      .then(([page, queue]) => {
        if (!current) return
        const items = applyMessagePage(page, true)
        applyQueueSnapshot(activeSession, queue)
        const pending = items.find(message => message.generationStatus === 'pending' && message.generationId)
        if (pending?.generationId) {
          activeGenerationSession.current = activeSession
          markSessionRunning(activeSession, true)
        } else {
          if (activeGenerationSession.current === activeSession) activeGenerationSession.current = null
          markSessionRunning(activeSession, false)
          if (!queue.paused && queue.items.length) void drainQueue(activeSession)
        }
      })
      .catch(error => { if (current) setToast(errorText(error)) })
      .finally(() => { if (current) setLoadingMessages(false) })
    return () => { current = false }
  }, [user, activeSession])

  useEffect(() => {
    activeSessionRef.current = activeSession
  }, [activeSession])

  useEffect(() => {
    showArchivedRef.current = showArchived
  }, [showArchived])

  useEffect(() => {
    if (!user || Object.keys(runningSessions).length === 0) return
    let stopped = false
    let timer: number | undefined
    const refresh = async () => {
      try {
        const items = await api.sessions(showArchivedRef.current)
        if (!stopped) setSessions(items)
      } catch {
        // The generation and its persisted pending record remain authoritative.
      }
      const activeId = activeSessionRef.current
      if (activeId) void refreshQueue(activeId).catch(() => undefined)
      if (!stopped) timer = window.setTimeout(() => void refresh(), 1200)
    }
    timer = window.setTimeout(() => void refresh(), 450)
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [user, runningSessions])

  useEffect(() => {
    const sessionId = activeSession
    const hasPendingGeneration = messages.some(
      message => message.role === 'assistant' && message.generationStatus === 'pending',
    )
    if (!user || !sessionId || loadingMessages || !hasPendingGeneration) return

    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const latest = await api.messages(sessionId, { limit: 50 })
        if (stopped) return
        const stillPending = latest.items.some(
          message => message.role === 'assistant' && message.generationStatus === 'pending',
        )
        if (!stillPending) {
          applyMessagePage(latest, false, false)
          if (activeGenerationSession.current === sessionId) activeGenerationSession.current = null
          markSessionRunning(sessionId, false)
          if (!pausedGenerationSessions.current.has(sessionId)) void drainQueue(sessionId)
          return
        }
      } catch {
        // Keep retrying while the persisted generation remains pending.
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 1500)
    }

    timer = window.setTimeout(() => void poll(), 1500)
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [user, activeSession, loadingMessages, messages])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const isAdmin = user?.role === 'admin'
  const activeSessionIsGenerating = Boolean(activeSession && runningSessions[activeSession])
  const sending = activeSessionIsGenerating
  const canceling = Boolean(activeSession && cancelingSessions[activeSession])
  const pendingPrompt = activeSession ? pendingPrompts[activeSession] ?? '' : ''
  const pendingTranslation = activeSession ? pendingTranslationEnabled[activeSession] ?? translationEnabled : translationEnabled
  const normalizedSessionSearch = sessionSearchDraft.trim()
  const searchResultIsCurrent = sessionSearchMatches?.query === normalizedSessionSearch
    && sessionSearchMatches.archived === showArchived
  const visibleSessions = !normalizedSessionSearch
    ? sessions
    : searchResultIsCurrent
      ? sessions.filter(session => sessionSearchMatches?.ids.includes(session.id))
      : []
  const sessionSearchPending = Boolean(normalizedSessionSearch) && !sessionSearchError && (
    normalizedSessionSearch !== sessionSearchQuery || !searchResultIsCurrent || sessionSearchLoading
  )

  function navigate(nextPage: Page) {
    setPage(nextPage)
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false)
  }

  async function handleLogin(email: string, password: string) {
    setAuthError('')
    setAuthNotice('')
    try {
      const result = await api.login(email, password)
      setUser(result.user)
      navigate('studio')
    } catch (error) {
      setAuthError(errorText(error))
    }
  }

  async function handleLogout() {
    try {
      await api.logout()
    } finally {
      setUser(null)
      setSessions([])
      clearMessages()
      optimisticUserMessagesRef.current = []
      setActiveSession(null)
      setReferenceImage(null)
      activeSessionRef.current = null
      activeGenerationSession.current = null
      runningSessionsRef.current = {}
      queuedGenerationsRef.current = {}
      pausedGenerationSessions.current.clear()
      cancelingSessionsRef.current = {}
      localGenerationSessions.current.clear()
      setRunningSessions({})
      setQueuedGenerations({})
      setCancelingSessions({})
      setPendingPrompts({})
      setPendingTranslationEnabled({})
      setSessionSearchDraft('')
      setSessionSearchOpen(false)
      navigate('studio')
    }
  }

  function handleSelfPasswordReset() {
    setAuthError('')
    setAuthNotice('Password reset. Existing sessions were signed out. Please log in with the new password.')
    setUser(null)
    setSessions([])
    clearMessages()
    optimisticUserMessagesRef.current = []
    setActiveSession(null)
    setReferenceImage(null)
    activeSessionRef.current = null
    runningSessionsRef.current = {}
    queuedGenerationsRef.current = {}
    pausedGenerationSessions.current.clear()
    cancelingSessionsRef.current = {}
    localGenerationSessions.current.clear()
    setRunningSessions({})
    setQueuedGenerations({})
    setCancelingSessions({})
    setPendingPrompts({})
    setPendingTranslationEnabled({})
    setSessionSearchDraft('')
    setSessionSearchOpen(false)
    navigate('studio')
  }

  async function createSession() {
    if (loadingEditImageId) return
    try {
      setSessionSearchDraft('')
      setSessionSearchOpen(false)
      if (showArchived) {
        showArchivedRef.current = false
        setShowArchived(false)
      }
      const session = await api.createSession()
      skipSessionLoad.current = session.id
      setSessions(current => [session, ...current.filter(item => item.id !== session.id)])
      activeSessionRef.current = session.id
      setActiveSession(session.id)
      clearMessages()
      navigate('studio')
      window.setTimeout(() => composerRef.current?.focus(), 80)
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function saveSessionTitle(id: string) {
    const title = sessionTitleDraft.trim()
    if (!title) return
    try {
      await api.renameSession(id, title)
      setSessions(current => current.map(session => session.id === id ? { ...session, title } : session))
      setSessionSearchVersion(version => version + 1)
      setEditingSession(null)
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function toggleSessionArchive(id: string, archived: boolean) {
    if (loadingEditImageId) return
    try {
      await api.setSessionArchived(id, archived)
      if (archived && activeSession === id) {
        activeSessionRef.current = null
        setActiveSession(null)
        clearMessages()
      }
      showArchivedRef.current = false
      setShowArchived(false)
      setSessions(await api.sessions(false))
      setToast(archived ? 'Session archived' : 'Session restored')
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function deleteSession(id: string) {
    if (loadingEditImageId) return
    const session = sessions.find(item => item.id === id)
    if (!session) return
    if (!window.confirm(`Permanently delete session "${session.title}"? Its messages, generations, queue items, and images cannot be recovered.`)) return
    try {
      await api.deleteSession(id)
      const remaining = sessions.filter(item => item.id !== id)
      setSessions(remaining)
      setSessionSearchVersion(version => version + 1)
      delete queuedGenerationsRef.current[id]
      delete runningSessionsRef.current[id]
      delete cancelingSessionsRef.current[id]
      setQueuedGenerations(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setRunningSessions(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      setCancelingSessions(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
      if (activeSessionRef.current === id) {
        const nextSession = remaining[0]?.id ?? null
        activeSessionRef.current = nextSession
        setActiveSession(nextSession)
        clearMessages()
      }
      setToast('Session deleted')
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function switchSessionList(archived: boolean) {
    if (loadingEditImageId) return
    showArchivedRef.current = archived
    setShowArchived(archived)
    activeSessionRef.current = null
    setActiveSession(null)
    clearMessages()
    try {
      setSessions(await api.sessions(archived))
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function loadOlderMessages(): Promise<boolean> {
    const sessionId = activeSessionRef.current
    const cursor = messagePage.nextCursor
    if (!sessionId || !cursor || loadingOlderMessages) return false
    setLoadingOlderMessages(true)
    try {
      const older = await api.messages(sessionId, { limit: 50, before: cursor })
      if (activeSessionRef.current !== sessionId) return false
      const next = mergeMessages(
        messageSessionRef.current === sessionId ? messagesRef.current : [],
        older.items,
      )
      messagesRef.current = next
      messageSessionRef.current = sessionId
      setMessages(next)
      setMessagePage({ hasMore: older.hasMore, nextCursor: older.nextCursor })
      return older.items.length > 0
    } catch (error) {
      setToast(errorText(error))
      return false
    } finally {
      setLoadingOlderMessages(false)
    }
  }

  async function reloadSessionData(id: string): Promise<Message[]> {
    const [page, nextSessions] = await Promise.all([api.messages(id, { limit: 50 }), api.sessions(showArchivedRef.current)])
    const nextMessages = activeSessionRef.current === id
      ? applyMessagePage(page, messageSessionRef.current !== id, messageSessionRef.current !== id)
      : page.items
    setSessions(nextSessions)
    const pending = nextMessages.find(message => message.generationStatus === 'pending' && message.generationId)
    if (pending?.generationId) {
      activeGenerationSession.current = id
      markSessionRunning(id, true)
    } else {
      if (activeGenerationSession.current === id) activeGenerationSession.current = null
      if (!queuedGenerationsRef.current[id]?.length) markSessionRunning(id, false)
    }
    if (!pending && runningSessionsRef.current[id] && !queuedGenerationsRef.current[id]?.length) {
      markSessionRunning(id, false)
    }
    return nextMessages
  }

  async function runGeneration(sessionId: string, request: QueuedGeneration): Promise<void> {
    if (runningSessionsRef.current[sessionId]) {
      void refreshQueue(sessionId).catch(error => setToast(errorText(error)))
      return
    }
    markSessionRunning(sessionId, true)
    localGenerationSessions.current.add(sessionId)
    activeGenerationSession.current = sessionId
    setPendingPrompts(current => ({ ...current, [sessionId]: request.prompt }))
    setPendingTranslationEnabled(current => ({ ...current, [sessionId]: request.translationEnabled }))
    markSessionCanceling(sessionId, false)
    setSessions(current => current.map(item => item.id === sessionId ? { ...item, running: true } : item))
    let serverStillRunning = false
    try {
      const result = await api.generate(
        sessionId,
        request.prompt,
        request.size,
        request.translationEnabled,
        undefined,
        request.id,
      )
      await reloadSessionData(sessionId)
      if (result.fallbackFrom) setToast(`The preferred model was unavailable. This request explicitly fell back to ${result.imageModel}`)
    } catch (error) {
      try {
        const latest = await reloadSessionData(sessionId)
        serverStillRunning = latest.some(message => message.generationStatus === 'pending')
        await refreshQueue(sessionId)
      } catch {
        // Keep the generation error visible even if the conversation cannot be refreshed.
      }
      const message = errorText(error)
      if (message !== 'The current session already has a generation in progress') setToast(message)
    } finally {
      if (!serverStillRunning && activeGenerationSession.current === sessionId) activeGenerationSession.current = null
      localGenerationSessions.current.delete(sessionId)
      setPendingPrompts(current => {
        const next = { ...current }
        delete next[sessionId]
        return next
      })
      setPendingTranslationEnabled(current => {
        const next = { ...current }
        delete next[sessionId]
        return next
      })
      markSessionRunning(sessionId, serverStillRunning)
      if (!serverStillRunning) markSessionCanceling(sessionId, false)
      setSessionSearchVersion(version => version + 1)
      if (!serverStillRunning && !pausedGenerationSessions.current.has(sessionId)) void drainQueue(sessionId)
    }
  }

  async function generatePrompt(value: string) {
    const text = value.trim()
    if (!text || loadingEditImageId) return
    const attachedImage = referenceImage
    const attachedMode = referenceMode
    setPrompt('')
    let sessionId = activeSession
    try {
      if (!sessionId) {
        const created = await api.createSession()
        sessionId = created.id
        skipSessionLoad.current = created.id
        activeSessionRef.current = created.id
        setActiveSession(created.id)
      }
      const referenceDataUrl = attachedImage ? await readImageDataUrl(attachedImage) : undefined
      await api.enqueue(sessionId, {
        prompt: text,
        size,
        translationEnabled,
        ...(referenceDataUrl ? { referenceImage: { dataUrl: referenceDataUrl, mode: attachedMode } } : {}),
      })
      addOptimisticUserMessage(
        sessionId,
        text,
        referenceDataUrl,
        referenceDataUrl ? attachedMode : 'generation',
        attachedImage?.size ?? 0,
      )
      setReferenceImage(null)
      pausedGenerationSessions.current.delete(sessionId)
      await refreshQueue(sessionId)
      await drainQueue(sessionId)
      if (runningSessionsRef.current[sessionId]) setToast('Added to the current session queue')
    } catch (error) {
      setToast(errorText(error))
      setPrompt(current => current || text)
    }
  }

  async function continueEditingImage(message: Message) {
    const generationId = message.generationId
    const sessionId = activeSession
    if (!generationId || !sessionId || loadingEditImageId) return
    setLoadingEditImageId(generationId)
    try {
      const image = await api.generationImage(generationId)
      if (activeSessionRef.current !== sessionId) return
      if (image.type !== 'image/png') throw new Error('Generated image format is invalid and cannot be loaded for editing')
      if (image.size > 10 * 1024 * 1024) throw new Error('Generated image exceeds 10 MiB and cannot be used as an edit reference')
      setReferenceImage(new File([image], `galaxy-${generationId.slice(0, 8)}.png`, { type: image.type }))
      setReferenceMode('edit')
      setPrompt('')
      navigate('studio')
      setToast('Image loaded. Describe what you want to change.')
      window.setTimeout(() => composerRef.current?.focus(), 80)
    } catch (error) {
      setToast(errorText(error))
    } finally {
      setLoadingEditImageId(null)
    }
  }

  async function cancelPrompt() {
    const sessionId = activeSession
    if (!sessionId || !runningSessionsRef.current[sessionId] || cancelingSessionsRef.current[sessionId]) return
    const recoveredGeneration = !localGenerationSessions.current.has(sessionId)
    pausedGenerationSessions.current.add(sessionId)
    markSessionCanceling(sessionId, true)
    try {
      await api.cancelGeneration(sessionId)
      setToast('Stop requested for the current generation')
      if (recoveredGeneration) {
        let latest: Message[] = []
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 75))
          latest = await reloadSessionData(sessionId)
          if (!latest.some(message => message.generationStatus === 'pending')) break
        }
      }
    } catch (error) {
      setToast(errorText(error))
      if (!runningSessionsRef.current[sessionId]) {
        pausedGenerationSessions.current.delete(sessionId)
        void drainQueue(sessionId)
      }
    } finally {
      if (recoveredGeneration) {
        markSessionCanceling(sessionId, false)
      }
    }
  }

  async function removeQueuedGeneration(sessionId: string, itemId: string): Promise<void> {
    try {
      await api.removeQueue(sessionId, itemId)
      await refreshQueue(sessionId)
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function updateQueuedPrompt(sessionId: string, itemId: string, prompt: string, enabled?: boolean): Promise<boolean> {
    try {
      const updated = await api.updateQueue(sessionId, itemId, {
        prompt,
        ...(enabled === undefined ? {} : { translationEnabled: enabled }),
      })
      const items = queuedGenerationsRef.current[sessionId] ?? []
      setSessionQueue(sessionId, items.map(item => item.id === itemId ? {
        ...item,
        prompt: updated.prompt,
        size: updated.size,
        translationEnabled: updated.translationEnabled,
        referenceMode: updated.referenceMode,
        hasReference: updated.hasReference,
        referenceImageBytes: updated.referenceImageBytes,
        persisted: true,
      } : item))
      return true
    } catch (error) {
      setToast(errorText(error))
      return false
    }
  }

  async function editQueuedGeneration(sessionId: string, itemId: string): Promise<void> {
    const items = queuedGenerationsRef.current[sessionId] ?? []
    const item = items.find(candidate => candidate.id === itemId)
    if (!item) return
    try {
      const referenceImage = item.hasReference
        ? await api.queueReference(sessionId, itemId).then(async ({ dataUrl }) => {
            const blob = await fetch(dataUrl).then(response => response.blob())
            return new File([blob], `queued-${itemId.slice(0, 8)}.${blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'}`, { type: blob.type })
          })
        : null
      await api.removeQueue(sessionId, itemId)
      setSessionQueue(
        sessionId,
        (queuedGenerationsRef.current[sessionId] ?? items).filter(candidate => candidate.id !== itemId),
      )
      if (activeSessionRef.current !== sessionId) {
        activeSessionRef.current = sessionId
        setActiveSession(sessionId)
      }
      setPrompt(item.prompt)
      setSize(item.size)
      setTranslationEnabled(item.translationEnabled)
      setReferenceImage(referenceImage)
      setReferenceMode(item.referenceMode)
      navigate('studio')
      window.setTimeout(() => composerRef.current?.focus(), 80)
      void refreshQueue(sessionId).catch(error => setToast(errorText(error)))
    } catch (error) {
      setToast(errorText(error))
    }
  }

  function sendPrompt(event?: FormEvent) {
    event?.preventDefault()
    void generatePrompt(prompt)
  }

  function handleTranslationEnabled(value: boolean): void {
    setTranslationEnabled(value)
    if (!value && size === 'auto') setSize(defaultDirectSize)
  }

  function handleSize(value: Size): void {
    setSize(!translationEnabled && value === 'auto' ? defaultDirectSize : value)
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendPrompt()
    }
  }

  useEffect(() => {
    function onShortcut(event: globalThis.KeyboardEvent) {
      if (!user) return
      if (event.key === 'Escape' && imagePreview) {
        event.preventDefault()
        setImagePreview(null)
        return
      }
      if (event.key === 'Escape' && sending && !cancelingSessions[activeSession ?? ''] && !prompt.trim()) {
        event.preventDefault()
        void cancelPrompt()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        void createSession()
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [user, sending, cancelingSessions, activeSession])

  if (!authReady) return <div className="boot-screen"><LoaderCircle className="spin" size={22} /></div>
  if (!user) return <Login onLogin={handleLogin} error={authError} notice={authNotice} />

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><img src="/favicon.svg" alt="" aria-hidden="true" /></div>
          {sidebarOpen && <div className="brand-copy"><strong>Galaxy Atelier</strong></div>}
          <button className="icon-button sidebar-toggle" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}><X size={16} /></button>
        </div>
        {!sidebarOpen && <button className="icon-button collapsed-open" title="Expand sidebar" onClick={() => setSidebarOpen(true)}><MessageSquare size={17} /></button>}
        {sidebarOpen && (
          <>
            <button className="new-session-button" onClick={() => void createSession()} disabled={loadingEditImageId !== null}>
              <Plus size={16} /> <span>New image session</span><kbd>Ctrl K</kbd>
            </button>
            <div className="session-list-heading">
              <div className="session-list-tabs" role="group" aria-label="Session filter">
                <button aria-pressed={!showArchived} onClick={() => void switchSessionList(false)} disabled={loadingEditImageId !== null}>Recent</button>
                <button aria-pressed={showArchived} onClick={() => void switchSessionList(true)} disabled={loadingEditImageId !== null}>Archived</button>
              </div>
              <div className="session-heading-actions">
                <button
                  className="session-search-toggle"
                  title={sessionSearchOpen ? 'Close search' : 'Search sessions'}
                  aria-label={sessionSearchOpen ? 'Close search' : 'Search sessions'}
                  aria-expanded={sessionSearchOpen}
                  onClick={() => {
                    if (sessionSearchOpen) {
                      setSessionSearchDraft('')
                      setSessionSearchOpen(false)
                    } else setSessionSearchOpen(true)
                  }}
                >
                  {sessionSearchOpen ? <X size={14} /> : <Search size={14} />}
                </button>
                <span>{visibleSessions.length}</span>
              </div>
            </div>
            {sessionSearchOpen && (
              <label className="session-search">
                <Search size={14} aria-hidden="true" />
                <input
                  ref={sessionSearchInputRef}
                  type="search"
                  value={sessionSearchDraft}
                  maxLength={120}
                  placeholder="Search sessions or descriptions"
                  aria-label="Search session names or history"
                  onChange={event => {
                    setSessionSearchError(false)
                    setSessionSearchDraft(event.target.value)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      setSessionSearchDraft('')
                      setSessionSearchOpen(false)
                    }
                  }}
                />
                {sessionSearchDraft && (
                  <button type="button" title="Clear search" aria-label="Clear search" onClick={() => setSessionSearchDraft('')}>
                    <X size={13} />
                  </button>
                )}
              </label>
            )}
            <div className="session-list">
              {visibleSessions.map(session => editingSession === session.id ? (
                <form className="session-rename" key={session.id} onSubmit={event => { event.preventDefault(); void saveSessionTitle(session.id) }}>
                  <input autoFocus maxLength={120} value={sessionTitleDraft} onChange={event => setSessionTitleDraft(event.target.value)} aria-label="Session name" />
                  <button className="icon-button" type="submit" title="Save name"><Check size={14} /></button>
                </form>
              ) : (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={activeSession === session.id}
                  onSelect={() => {
                    if (loadingEditImageId !== null) return
                    activeSessionRef.current = session.id
                    setActiveSession(session.id)
                    navigate('studio')
                  }}
                  onRename={() => { setEditingSession(session.id); setSessionTitleDraft(session.title) }}
                  onArchive={() => void toggleSessionArchive(session.id, !session.archivedAt)}
                  onDelete={() => void deleteSession(session.id)}
                  archived={Boolean(session.archivedAt)}
                  disabled={loadingEditImageId !== null}
                />
              ))}
              {!visibleSessions.length && (
                <div className="empty-sessions">
                  {normalizedSessionSearch
                    ? sessionSearchPending ? 'Searching…' : sessionSearchError ? 'Search failed' : 'No matching sessions'
                    : showArchived ? 'No archived sessions' : 'No sessions yet'}
                </div>
              )}
            </div>
            <div className="sidebar-spacer" />
            <button className={`side-link ${page === 'studio' ? 'active' : ''}`} onClick={() => navigate('studio')}>
              <ImageIcon size={16} /><span>Image Studio</span>
            </button>
            <button className={`side-link ${page === 'usage' ? 'active' : ''}`} onClick={() => navigate('usage')}>
              <Activity size={16} /><span>My Usage</span>
            </button>
            {isAdmin && (
              <div className="admin-nav">
                <div className="side-section-label admin-label"><span>Admin</span><Shield size={13} /></div>
                <button className={`side-link ${page === 'stats' ? 'active' : ''}`} onClick={() => navigate('stats')}><BarChart3 size={16} /><span>Overview</span></button>
                <button className={`side-link ${page === 'users' ? 'active' : ''}`} onClick={() => navigate('users')}><Users size={16} /><span>Account management</span></button>
                <button className={`side-link ${page === 'providers' ? 'active' : ''}`} onClick={() => navigate('providers')}><KeyRound size={16} /><span>Models & keys</span></button>
                <button className={`side-link ${page === 'logs' ? 'active' : ''}`} onClick={() => navigate('logs')}><ScrollText size={16} /><span>Audit logs</span></button>
              </div>
            )}
            <div className="account-row">
              <div className="avatar">{user.email.slice(0, 1).toUpperCase()}</div>
              <div className="account-copy"><strong>{user.email}</strong><span>{isAdmin ? 'Admin' : 'Member'}</span></div>
              <button className="icon-button logout-button" title="Sign out" onClick={() => void handleLogout()}><LogOut size={16} /></button>
            </div>
          </>
        )}
      </aside>
      {sidebarOpen && <button className="mobile-scrim" type="button" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}

      <main className="main-column">
        <header className="topbar">
          {!sidebarOpen && <button className="icon-button" title="Expand sidebar" onClick={() => setSidebarOpen(true)}><MessageSquare size={17} /></button>}
          <div className="breadcrumb"><span>Galaxy</span><span className="crumb-divider">/</span><strong>{pageLabels[page]}</strong></div>
          <div className="topbar-meta">
            <LanguageSwitcher language={language} onChange={handleLanguageChange} />
            <span className="topbar-separator" />
            <ThemeSwitcher theme={theme} onChange={setTheme} />
            <span className="topbar-separator" />
            <span className="topbar-user">{user.email}</span>
          </div>
        </header>

        {page === 'studio' && (
          <Studio
            messages={messages}
            loading={loadingMessages}
            hasOlderMessages={messagePage.hasMore}
            loadingOlderMessages={loadingOlderMessages}
            onLoadOlder={loadOlderMessages}
            sending={sending}
            canceling={canceling}
            pendingPrompt={activeSessionIsGenerating ? pendingPrompt : ''}
            pendingTranslationEnabled={activeSessionIsGenerating ? pendingTranslation : translationEnabled}
            queuedGenerations={activeSession ? queuedGenerations[activeSession] ?? [] : []}
            prompt={prompt}
            translationEnabled={translationEnabled}
            size={size}
            referenceImage={referenceImage}
            referenceMode={referenceMode}
            sessions={sessions}
            activeSession={activeSession}
            readOnly={showArchived || Boolean(sessions.find(item => item.id === activeSession)?.archivedAt)}
            preparingEditImageId={loadingEditImageId}
            composerRef={composerRef}
            onPrompt={setPrompt}
            onTranslationEnabled={handleTranslationEnabled}
            onSize={handleSize}
            onReferenceImage={setReferenceImage}
            onReferenceMode={setReferenceMode}
            onSubmit={sendPrompt}
             onCancel={() => void cancelPrompt()}
            onKeyDown={handleComposerKey}
            onSuggestion={value => { setPrompt(value); composerRef.current?.focus() }}
            onNewSession={() => void createSession()}
            onRetry={value => void generatePrompt(value)}
            onUseImage={continueEditingImage}
            onRemoveQueued={itemId => { if (activeSession) removeQueuedGeneration(activeSession, itemId) }}
            onUpdateQueued={activeSession ? (itemId, value, enabled) => updateQueuedPrompt(activeSession, itemId, value, enabled) : async () => false}
            onEditQueued={itemId => { if (activeSession) editQueuedGeneration(activeSession, itemId) }}
            onRestore={() => { if (activeSession) void toggleSessionArchive(activeSession, false) }}
            onPreviewImage={(url, alt, title) => setImagePreview({ url, alt, title })}
          />
        )}
        {page === 'usage' && <UsagePage />}
        {page === 'stats' && isAdmin && <AdminStatsPage onNavigate={navigate} />}
        {page === 'users' && isAdmin && <UsersPage currentUserId={user.id} onSelfPasswordReset={handleSelfPasswordReset} onToast={setToast} onNavigate={navigate} />}
        {page === 'providers' && isAdmin && <ProvidersPage onToast={setToast} onNavigate={navigate} />}
        {page === 'logs' && isAdmin && <LogsPage onNavigate={navigate} />}
      </main>
      {toast && <div className="toast" role="status"><AlertCircle size={16} />{toast}<button className="icon-button" onClick={() => setToast('')}><X size={15} /></button></div>}
      {imagePreview && <ImagePreviewModal preview={imagePreview} onClose={() => setImagePreview(null)} />}
    </div>
  )
}

function SessionRow({ session, selected, onSelect, onRename, onArchive, onDelete, archived, disabled }: {
  session: SessionSummary
  selected: boolean
  onSelect: () => void
  onRename: () => void
  onArchive: () => void
  onDelete: () => void
  archived: boolean
  disabled: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ top: number, left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuPortalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function reposition() {
      const button = menuButtonRef.current
      if (!button) return
      const rect = button.getBoundingClientRect()
      const menuWidth = 176
      const menuHeight = archived ? 84 : 120
      const top = rect.bottom + 4 + menuHeight <= window.innerHeight
        ? rect.bottom + 4
        : Math.max(8, rect.top - menuHeight - 4)
      const left = Math.min(
        Math.max(8, rect.right - menuWidth),
        Math.max(8, window.innerWidth - menuWidth - 8),
      )
      setMenuPosition({ top, left })
    }
    function dismiss(event: PointerEvent) {
      if (
        event.target instanceof Node
        && !menuRef.current?.contains(event.target)
        && !menuPortalRef.current?.contains(event.target)
      ) setMenuOpen(false)
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    reposition()
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [archived, menuOpen])

  function openMenu(): void {
    const button = menuButtonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const menuWidth = 176
    const menuHeight = archived ? 84 : 120
    const top = rect.bottom + 4 + menuHeight <= window.innerHeight
      ? rect.bottom + 4
      : Math.max(8, rect.top - menuHeight - 4)
    const left = Math.min(
      Math.max(8, rect.right - menuWidth),
      Math.max(8, window.innerWidth - menuWidth - 8),
    )
    setMenuPosition({ top, left })
    setMenuOpen(true)
  }

  return (
    <div className={`session-row-wrap ${selected ? 'selected' : ''}`} ref={menuRef}>
      <button className="session-row" onClick={onSelect} title={session.title} disabled={disabled}>
        <MessageSquare size={15} />{session.running && <span className="session-running-dot" title="Generating" aria-label="Generating" />}<span>{session.title}</span>
      </button>
      <button
        ref={menuButtonRef}
        className="session-edit-button"
        title="Session actions"
        aria-label={`Session actions: ${session.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => menuOpen ? setMenuOpen(false) : openMenu()}
      >
        <MoreHorizontal size={15} />
      </button>
      {menuOpen && menuPosition && createPortal(
        <div ref={menuPortalRef} className="session-context-menu" style={menuPosition} role="menu" aria-label={`${session.title}  of Session actions`}>
          {!archived && <button role="menuitem" onClick={() => { setMenuOpen(false); onRename() }}><Pencil size={14} />Rename</button>}
          <button role="menuitem" onClick={() => { setMenuOpen(false); onArchive() }}>
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {archived ? 'Restore session' : 'Archive session'}
          </button>
          <button
            role="menuitem"
            disabled={session.running}
            title={session.running ? 'Stop the active generation before deleting this session' : 'Delete session permanently'}
            onClick={() => { setMenuOpen(false); onDelete() }}
          ><Trash2 size={14} />Delete session</button>
        </div>,
        document.body,
      )}
    </div>
  )
}

function Login({ onLogin, error, notice }: { onLogin: (email: string, password: string) => void, error: string, notice: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    await onLogin(email, password)
    setBusy(false)
  }
  return (
    <main className="login-page">
      <div className="login-left">
        <div className="login-brand"><div className="brand-mark"><img src="/favicon.svg" alt="" aria-hidden="true" /></div><strong>Galaxy Atelier</strong></div>
        <div className="login-content">
          <h1>Turn imagination<br /><em>into images.</em></h1>
          <p>Create with natural language. Your sessions, generations, and usage stay in your account.</p>
        </div>
      </div>
      <section className="login-right">
        <form className="login-form" onSubmit={submit}>
          <div className="form-icon"><Shield size={19} /></div>
          <div className="login-form-kicker">WELCOME BACK</div>
          <h2>Sign in to workspace</h2>
          <p>Continue with an account created by an administrator.</p>
          <div className="login-field">
            <label className="field-label" htmlFor="login-email">Email</label>
            <div className="login-input-shell">
              <Mail size={17} aria-hidden="true" />
              <input id="login-email" className="login-input" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} placeholder="name@company.com" />
            </div>
          </div>
          <div className="login-field">
            <label className="field-label" htmlFor="login-password">Password</label>
            <div className="login-input-shell">
              <LockKeyhole size={17} aria-hidden="true" />
              <input id="login-password" className="login-input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter password" />
              <button type="button" className="password-toggle" title={showPassword ? 'Hide password' : 'Show password'} aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(value => !value)}>
                {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
          </div>
          {error && <div className="form-error"><AlertCircle size={15} />{error}</div>}
          {notice && <div className="form-success"><Check size={15} />{notice}</div>}
          <button className="primary-button login-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <>Enter workspace <ArrowUp size={16} /></>}</button>
        </form>
      </section>
    </main>
  )
}

function Studio(props: {
  messages: Message[]
  loading: boolean
  hasOlderMessages: boolean
  loadingOlderMessages: boolean
  onLoadOlder: () => Promise<boolean>
  sending: boolean
  canceling: boolean
  pendingPrompt: string
  pendingTranslationEnabled: boolean
  queuedGenerations: QueuedGeneration[]
  prompt: string
  translationEnabled: boolean
  size: Size
  referenceImage: File | null
  referenceMode: ReferenceMode
  sessions: SessionSummary[]
  activeSession: string | null
  readOnly: boolean
  preparingEditImageId: string | null
  composerRef: React.RefObject<HTMLTextAreaElement>
  onPrompt: (value: string) => void
  onTranslationEnabled: (value: boolean) => void
  onSize: (value: Size) => void
  onReferenceImage: (value: File | null) => void
  onReferenceMode: (value: 'edit' | 'reference') => void
  onSubmit: (event?: FormEvent) => void
  onCancel: () => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onSuggestion: (value: string) => void
  onNewSession: () => void
  onRetry: (value: string) => void
  onUseImage: (message: Message) => void
  onRemoveQueued: (itemId: string) => void
  onUpdateQueued: (itemId: string, prompt: string, translationEnabled: boolean) => Promise<boolean>
  onEditQueued: (itemId: string) => void
  onRestore: () => void
  onPreviewImage: (url: string, alt: string, title: string) => void
}) {
  const [showLatestButton, setShowLatestButton] = useState(false)
  const [referencePreview, setReferencePreview] = useState('')
  const [referenceError, setReferenceError] = useState('')
  const [draggingReference, setDraggingReference] = useState(false)
  const referenceDragDepthRef = useRef(0)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const referenceInputRef = useRef<HTMLInputElement>(null)
  const followLatestRef = useRef(new ChatScrollFollow())
  const prependAnchorRef = useRef<{ scrollTop: number, scrollHeight: number, oldestMessageId?: string } | null>(null)
  const previousSessionRef = useRef(props.activeSession)
  const previousPendingPromptRef = useRef(props.pendingPrompt)
  const sessionTitle = props.sessions.find(item => item.id === props.activeSession)?.title
  useEffect(() => {
    if (!props.referenceImage) {
      setReferencePreview('')
      return
    }
    const previewUrl = URL.createObjectURL(props.referenceImage)
    setReferencePreview(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [props.referenceImage])

  async function selectReferenceImage(file?: File) {
    if (!file) return
    setReferenceError('Checking and converting image…')
    try {
      const normalized = await normalizeImageFile(file)
      setReferenceError('')
      props.onReferenceImage(normalized)
    } catch (error) {
      setReferenceError(errorText(error))
    }
  }

  function hasImageTransfer(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.items).some(item => item.kind === 'file' && (item.type === '' || item.type.startsWith('image/')))
      || Array.from(dataTransfer.files).some(isPotentialImageFile)
  }

  function handleReferenceDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (props.readOnly || !hasImageTransfer(event.dataTransfer)) return
    event.preventDefault()
    referenceDragDepthRef.current += 1
    setDraggingReference(true)
  }

  function handleReferenceDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (props.readOnly) return
    if (!hasImageTransfer(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDraggingReference(true)
  }

  function handleReferenceDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (props.readOnly) return
    event.preventDefault()
    referenceDragDepthRef.current = Math.max(0, referenceDragDepthRef.current - 1)
    if (referenceDragDepthRef.current === 0) setDraggingReference(false)
  }

  function handleReferenceDrop(event: React.DragEvent<HTMLDivElement>) {
    if (props.readOnly) return
    event.preventDefault()
    referenceDragDepthRef.current = 0
    setDraggingReference(false)
    const file = Array.from(event.dataTransfer.files).find(isPotentialImageFile)
    void selectReferenceImage(file)
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (props.readOnly || props.referenceImage) return
    const file = Array.from(event.clipboardData.files).find(isPotentialImageFile)
    if (!file) return
    event.preventDefault()
    void selectReferenceImage(file)
  }

  function scrollToLatest() {
    const viewport = scrollContainerRef.current
    if (!viewport) return
    followLatestRef.current.reset()
    viewport.scrollTop = viewport.scrollHeight
    setShowLatestButton(false)
  }

  async function handleLoadOlderMessages() {
    const viewport = scrollContainerRef.current
    if (!viewport || props.loadingOlderMessages) return
    const anchor = {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      oldestMessageId: props.messages[0]?.id,
    }
    prependAnchorRef.current = anchor
    const loaded = await props.onLoadOlder()
    if (!loaded && prependAnchorRef.current === anchor) prependAnchorRef.current = null
  }

  useLayoutEffect(() => {
    const sessionChanged = previousSessionRef.current !== props.activeSession
    const submittedTurn = !previousPendingPromptRef.current && Boolean(props.pendingPrompt)
    previousSessionRef.current = props.activeSession
    previousPendingPromptRef.current = props.pendingPrompt
    if (sessionChanged) prependAnchorRef.current = null
    const anchor = prependAnchorRef.current
    if (!sessionChanged && anchor && props.messages[0]?.id !== anchor.oldestMessageId) {
      prependAnchorRef.current = null
      const viewport = scrollContainerRef.current
      if (viewport) {
        viewport.scrollTop = preserveScrollAnchor(anchor.scrollTop, anchor.scrollHeight, viewport.scrollHeight)
        const state = followLatestRef.current.sample({
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
          scrollTop: viewport.scrollTop,
        })
        setShowLatestButton(state.showLatestButton)
      }
      return
    }
    if (sessionChanged || submittedTurn || followLatestRef.current.isFollowing) scrollToLatest()
  }, [props.activeSession, props.messages, props.pendingPrompt])

  useEffect(() => {
    const viewport = scrollContainerRef.current
    const feed = viewport?.querySelector<HTMLElement>('.message-feed')
    if (!viewport || !feed || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followLatestRef.current.isFollowing) {
        scrollToLatest()
        return
      }
      const state = followLatestRef.current.sample({
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        scrollTop: viewport.scrollTop,
      })
      setShowLatestButton(state.showLatestButton)
    })
    observer.observe(feed)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [props.activeSession, props.loading, props.messages.length, props.pendingPrompt])

  function handleConversationScroll() {
    const viewport = scrollContainerRef.current
    if (!viewport) return
    const state = followLatestRef.current.sample({
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      scrollTop: viewport.scrollTop,
    })
    setShowLatestButton(state.showLatestButton)
  }

  const suggestions = [
    'A Tokyo record store on a rainy night, film photography',
    'A glass greenhouse floating above the clouds, surrealism',
    'A seaside lighthouse travel poster, vintage screen print',
  ]
  return (
    <section className="studio-page">
      <div className="studio-heading">
        <div><span className="section-kicker">{props.readOnly ? 'ARCHIVED SESSION' : 'CREATE / CONVERSE'}</span><h1>{sessionTitle ?? 'Create a new image'}</h1></div>
        {props.readOnly && <button className="quiet-action restore-session-button" onClick={props.onRestore}><ArchiveRestore size={15} />Restore session</button>}
      </div>
      <div className="conversation-region">
        <div className="conversation-scroll" ref={scrollContainerRef} onScroll={handleConversationScroll}>
          {props.loading ? (
            <div className="conversation-loading"><LoaderCircle className="spin" size={21} />Restoring session</div>
          ) : !props.messages.length && !props.pendingPrompt ? (
            <div className="welcome-state">
              <div className="welcome-mark"><img src="/favicon.svg" alt="" aria-hidden="true" /></div>
              <div className="welcome-overline">YOUR CREATIVE SESSION</div>
              <h2>Describe a scene,<br />and start here.</h2>
              <p>Natural language is refined into an image prompt before it is sent to the image model.</p>
              <div className="suggestion-list">
                {suggestions.map((item, index) => <button key={item} onClick={() => props.onSuggestion(item)}><span>0{index + 1}</span>{item}<ArrowUp size={14} /></button>)}
              </div>
              {!props.activeSession && <button className="quiet-action" onClick={props.onNewSession}><Plus size={15} />Create standalone session</button>}
            </div>
          ) : (
            <div className="message-feed">
              {props.hasOlderMessages && (
                <button
                  className="load-older-messages"
                  type="button"
                  disabled={props.loadingOlderMessages}
                  onClick={() => void handleLoadOlderMessages()}
                >
                  {props.loadingOlderMessages ? <LoaderCircle className="spin" size={14} /> : <ArrowUp size={14} />}
                  {props.loadingOlderMessages ? 'Loading' : 'Load older messages'}
                </button>
              )}
              {props.messages.map(message => <MessageItem
                key={message.id}
                message={message}
                onRetry={props.onRetry}
                onUseImage={() => props.onUseImage(message)}
                preparingEditImage={props.preparingEditImageId === message.generationId}
                readOnly={props.readOnly}
                onCancel={props.onCancel}
                sending={props.sending}
                canceling={props.canceling}
                onPreviewImage={props.onPreviewImage}
              />)}
              {props.pendingPrompt && <PendingTurn translationEnabled={props.pendingTranslationEnabled} />}
            </div>
          )}
        </div>
        {showLatestButton && (
          <button
            className="latest-message-button"
            type="button"
            title="Jump to latest"
            aria-label="Jump to latest"
            onClick={scrollToLatest}
          >
            <ArrowDown size={17} />
          </button>
        )}
      </div>
      {props.readOnly ? (
        <div className="archived-notice"><Archive size={15} />This session is archived and read-only. Restore it to continue generating.</div>
      ) : <form className="composer-wrap" onSubmit={props.onSubmit}>
        <div
          className={`composer-box ${draggingReference ? 'drop-target' : ''}`}
          onDragEnter={handleReferenceDragEnter}
          onDragOver={handleReferenceDragOver}
          onDragLeave={handleReferenceDragLeave}
          onDrop={handleReferenceDrop}
        >
          {draggingReference && <div className="drop-hint" aria-hidden="true"><ImagePlus size={15} />Drop to upload image</div>}
          {props.referenceImage && (
            <div className="reference-attachment">
              <img src={referencePreview} alt="" />
              <span className="reference-file-name" title={props.referenceImage.name}>{props.referenceImage.name}</span>
              <div className="reference-mode" role="group" aria-label="Reference image purpose">
                <button type="button" aria-pressed={props.referenceMode === 'edit'} onClick={() => props.onReferenceMode('edit')}>Edit original</button>
                <button type="button" aria-pressed={props.referenceMode === 'reference'} onClick={() => props.onReferenceMode('reference')}>Visual reference</button>
              </div>
              <button
                className="icon-button reference-remove"
                type="button"
                title="Remove reference image"
                aria-label="Remove reference image"
                onClick={() => props.onReferenceImage(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <input
            ref={referenceInputRef}
            className="visually-hidden"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Choose reference image"
            onChange={event => {
              void selectReferenceImage(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
          <textarea
            ref={props.composerRef}
            value={props.prompt}
            onChange={event => props.onPrompt(event.target.value)}
            onKeyDown={props.onKeyDown}
            onPaste={handleComposerPaste}
            placeholder="Describe the image you want to create..."
            rows={2}
            maxLength={4000}
          />
          <div className="composer-controls">
            <div className="composer-options">
              <button
                className="icon-button reference-picker"
                type="button"
                title="Add reference image"
                aria-label="Add reference image"
                onClick={() => referenceInputRef.current?.click()}
              >
                <ImagePlus size={16} />
              </button>
              <SelectorPopover
                id="size-selector"
                className="size-control"
                title={props.referenceImage ? 'Reference mode follows the original orientation' : 'Output aspect ratio'}
                ariaLabel="Image aspect ratio"
                icon={<ImageIcon size={14} aria-hidden="true" />}
                value={props.size}
                options={sizeOptions}
                onChange={props.onSize}
                disabled={Boolean(props.referenceImage)}
              />
              <label className="translation-toggle" title={props.translationEnabled ? 'Use the prompt model to refine an English prompt first' : 'Skip the prompt model and send the user text directly'}>
                <input
                  type="checkbox"
                  checked={props.translationEnabled}
                  onChange={event => props.onTranslationEnabled(event.target.checked)}
                />
                <Sparkles size={13} />
                <span>Prompt model</span>
              </label>
              <span className="composer-divider" />
              <span className="agent-route"><Sparkles size={14} /> {props.translationEnabled ? 'Prompt Agent' : 'User text'} <span>→</span> Image</span>
              <span className="character-count">{props.prompt.length}/4000</span>
            </div>
            <button
              className={`send-button ${props.prompt.trim() ? 'ready' : ''} ${props.sending && !props.prompt.trim() ? 'stop' : ''}`}
              type={props.sending && !props.prompt.trim() ? 'button' : 'submit'}
              onClick={props.sending && !props.prompt.trim() ? props.onCancel : undefined}
              disabled={props.sending && !props.prompt.trim() ? props.canceling : !props.prompt.trim()}
              aria-label={props.sending && !props.prompt.trim() ? 'Stop generation' : props.sending ? 'Add to generation queue' : 'Generate image'}
              title={props.sending && !props.prompt.trim() ? 'Stop generation' : props.sending ? 'Add to generation queue' : 'Generate image'}
            >
              {props.sending && !props.prompt.trim()
                ? props.canceling ? <LoaderCircle className="spin" size={17} /> : <Square size={15} fill="currentColor" />
                : <Send size={17} />}
            </button>
          </div>
        </div>
        {referenceError && <div className="reference-error" role="alert">{referenceError}</div>}
      </form>}
      {!props.readOnly && props.queuedGenerations.length > 0 && (
        <QueueDock
          items={props.queuedGenerations}
          running={props.sending}
          onRemove={props.onRemoveQueued}
          onUpdate={props.onUpdateQueued}
          onEdit={props.onEditQueued}
        />
      )}
    </section>
  )
}

function QueueDock({ items, running, onRemove, onUpdate, onEdit }: {
  items: QueuedGeneration[]
  running: boolean
  onRemove: (itemId: string) => void
  onUpdate: (itemId: string, prompt: string, translationEnabled: boolean) => Promise<boolean>
  onEdit: (itemId: string) => void
}) {
  const [editing, setEditing] = useState<{ id: string, prompt: string, translationEnabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing || !editing.prompt.trim() || busy) return
    setBusy(true)
    try {
      if (await onUpdate(editing.id, editing.prompt.trim(), editing.translationEnabled)) setEditing(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="queue-dock" aria-label="Pending generation queue">
      <div className="queue-heading">
        <div className="queue-title"><List size={15} /><strong>Pending queue</strong><span>{items.length}</span></div>
        {running && <span className="queue-status"><Clock3 size={12} />Processed after the current request completes</span>}
      </div>
      <ol className="queue-list">
        {items.map((item, index) => (
          <li className="queue-item" key={item.id}>
            <span className="queue-index">{index + 1}</span>
            {editing?.id === item.id ? (
              <form className="queue-edit-form" onSubmit={event => void saveEdit(event)}>
                <textarea
                  aria-label="Edit queued prompt"
                  maxLength={4000}
                  rows={2}
                  value={editing.prompt}
                  disabled={busy}
                  onChange={event => setEditing({ ...editing, prompt: event.target.value })}
                  onKeyDown={event => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                    if (event.key === 'Escape' && !busy) setEditing(null)
                  }}
                />
                <label className="queue-translation-toggle">
                  <input
                    type="checkbox"
                    checked={editing.translationEnabled}
                    disabled={busy}
                    onChange={event => setEditing({ ...editing, translationEnabled: event.target.checked })}
                  />
                  <Sparkles size={12} />
                  {editing.translationEnabled ? 'Use prompt model' : 'Skip prompt model'}
                </label>
                <div className="queue-edit-actions">
                  <button className="queue-action" type="button" title="Cancel editing" aria-label="Cancel editing" disabled={busy} onClick={() => setEditing(null)}><X size={14} /></button>
                  <button className="queue-action" type="submit" title="Save prompt" aria-label="Save prompt" disabled={busy || !editing.prompt.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}</button>
                </div>
              </form>
            ) : (
              <>
                <div className="queue-copy">
                  <span>{item.prompt}</span>
                  <small>{sizeLabel(item.size)} · {item.translationEnabled ? 'Use prompt model' : 'Skip prompt model'}{(item.referenceImage || item.hasReference) ? ` · ${item.referenceMode === 'edit' ? 'Edit original' : 'Visual reference'}` : ''}</small>
                </div>
                <button className="queue-action" type="button" title="Edit queued prompt" aria-label={`Edit item ${index + 1} item prompt`} disabled={busy} onClick={() => setEditing({ id: item.id, prompt: item.prompt, translationEnabled: item.translationEnabled })}><Pencil size={13} /></button>
                <button className="queue-action" type="button" title="Move to input" aria-label={`Move item ${index + 1} itemMove to input`} disabled={busy} onClick={() => onEdit(item.id)}><ArrowUp size={13} /></button>
                <button className="queue-action" type="button" title="Remove queue item" aria-label={`Remove item ${index + 1} item`} disabled={busy} onClick={() => onRemove(item.id)}><Trash2 size={13} /></button>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

function ImagePreviewModal({ preview, onClose }: {
  preview: { url: string, alt: string, title: string }
  onClose: () => void
}) {
  return (
    <div className="image-preview-modal" role="dialog" aria-modal="true" aria-label={preview.title} onClick={onClose}>
      <div className="image-preview-dialog" onClick={event => event.stopPropagation()}>
        <div className="image-preview-toolbar">
          <strong>{preview.title}</strong>
          <button className="icon-button" type="button" title="Close preview" aria-label="Close preview" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="image-preview-canvas">
          <img src={preview.url} alt={preview.alt} />
        </div>
      </div>
    </div>
  )
}

function WorkedSummary({ message }: { message: Message }) {
  return (
    <details className="worked-summary">
      <summary><span>Duration {durationLabel(message.durationMs)}</span><ChevronDown size={15} /></summary>
      <div className="worked-details">
        <div className="tool-trace">
          <div className="trace-step done"><span className="trace-icon"><Check size={12} /></span><span><b>{message.translationEnabled === false ? 'Submit original description directly' : 'Prompt refinement'}</b><small>{message.translationEnabled === false ? 'Prompt model skipped' : message.translationModel}</small></span><i>{message.translationEnabled === false ? '0 tokens' : `${number((message.translationInputTokens ?? 0) + (message.translationOutputTokens ?? 0))} tokens`}</i></div>
          <div className="trace-connector" />
          <div className="trace-step done"><span className="trace-icon image-trace"><ImageIcon size={12} /></span><span><b>Image generation</b><small>{message.imageModel}{message.requestedImageModel && message.requestedImageModel !== message.imageModel ? ` (by ${message.requestedImageModel} fallback)` : ''}</small></span><i>{message.imageWidth && message.imageHeight ? `${message.imageWidth} × ${message.imageHeight}` : durationLabel(message.durationMs)}</i></div>
        </div>
      </div>
    </details>
  )
}

function MessageItem({ message, onRetry, onUseImage, preparingEditImage, readOnly, onCancel, sending, canceling, onPreviewImage }: {
  message: Message
  onRetry: (value: string) => void
  onUseImage: () => void
  preparingEditImage: boolean
  readOnly: boolean
  onCancel: () => void
  sending: boolean
  canceling: boolean
  onPreviewImage: (url: string, alt: string, title: string) => void
}) {
  if (message.role === 'user') {
    const inputAlt = message.imageMode === 'edit' ? 'User-uploaded edit image' : 'User-uploaded reference image'
    return <article className="user-message"><div className="message-avatar user-avatar">U</div><div className="user-message-content"><div className="message-meta"><strong>You</strong><time>{timeLabel(message.createdAt)}</time></div><p>{message.content}</p>{message.inputImageUrl && <button className="image-preview-button input-image-link" type="button" title="Enlarge image preview" onClick={() => onPreviewImage(message.inputImageUrl!, inputAlt, 'User-uploaded image')}><img className="input-image" src={message.inputImageUrl} alt={inputAlt} loading="lazy" /></button>}{message.imageMode === 'edit' && <span className="message-mode">Edit original</span>}{message.imageMode === 'reference' && <span className="message-mode">Visual reference</span>}</div></article>
  }
  const hasGeneration = Boolean(message.generationId)
  const pending = hasGeneration && message.generationStatus === 'pending'
  return (
    <article className={`assistant-message ${pending ? 'pending-turn' : ''}`}>
      <div className="message-avatar agent-avatar"><Sparkles size={15} /></div>
      <div className="assistant-content">
        <div className="message-meta"><strong>Galaxy Atelier</strong>{pending ? <span className="live-indicator"><span className="mini-dot green" />Processing</span> : <time>{timeLabel(message.createdAt)}</time>}</div>
        {pending ? (
          <><PendingTrace translationEnabled={message.translationEnabled !== false} /><button className="text-action" disabled={canceling} onClick={onCancel}><Square size={13} fill="currentColor" />Stop</button></>
        ) : hasGeneration && message.generationStatus === 'succeeded' ? (
          <>
            <WorkedSummary message={message} />
            {(message.modelFeedback || message.revisedPrompt) && <p className="assistant-text generation-response">{message.modelFeedback || message.revisedPrompt}</p>}
            {(message.translatedPrompt || message.originalPrompt) && <details className="translated-prompt"><summary><span>Generated prompt</span><ChevronDown size={14} /></summary><p>{message.translatedPrompt ?? message.originalPrompt}</p></details>}
            {message.revisedPrompt && message.revisedPrompt !== message.translatedPrompt && <details className="translated-prompt provider-prompt"><summary><span>Model revision</span><ChevronDown size={14} /></summary><p>{message.revisedPrompt}</p></details>}
            {message.imageUrl && <div className="image-result">
              <button className="image-preview-button generated-image-link" type="button" title="Enlarge image preview" onClick={() => onPreviewImage(message.imageUrl!, message.imageName ?? 'Generated image', message.imageName ?? 'Generated image')}><img className="generated-image" src={message.imageUrl} alt={message.imageName ?? 'Generated image'} loading="lazy" /></button>
              {!readOnly && <button
                className="image-edit"
                type="button"
                title={preparingEditImage ? 'Loading image' : 'Continue editing with this image'}
                aria-label={preparingEditImage ? 'Loading image' : 'Continue editing with this image'}
                disabled={sending || preparingEditImage}
                onClick={onUseImage}
              >{preparingEditImage ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={15} />}</button>}
              <a className="image-download" href={message.imageUrl} download={imageDownloadName(message)} title={`Download image: ${message.imageName ?? 'Generate image'}`}><Download size={15} /></a>
              <button className="image-open-link" type="button" onClick={() => onPreviewImage(message.imageUrl!, message.imageName ?? 'Generated image', message.imageName ?? 'Generated image')}><ImageIcon size={16} />Enlarge preview</button>
            </div>}
            <div className="result-meta"><span>Name: {message.imageName ?? 'Generated image'}</span><span>Model: {message.imageModel ?? 'Not recorded'}{message.imageWidth && message.imageHeight ? ` · ${message.imageWidth} × ${message.imageHeight}` : ''}</span><span><Check size={13} />Completed</span><span><Coins size={13} />{money(message.costUsd)}</span><span>{number((message.translationInputTokens ?? 0) + (message.translationOutputTokens ?? 0) + (message.imageInputTokens ?? 0) + (message.imageOutputTokens ?? 0))} tokens</span></div>
            {costBreakdown(message.translationTokenCostUsd, message.imageTokenCostUsd, message.imageRequestCostUsd, message.costUsd) && <small className="cost-breakdown">{costBreakdown(message.translationTokenCostUsd, message.imageTokenCostUsd, message.imageRequestCostUsd, message.costUsd)}</small>}
          </>
        ) : hasGeneration ? (
          <>
            <div className="failed-result">
              <AlertCircle size={15} />
              <span>{message.errorCode === 'generation-cancelled' ? 'Generation stopped' : 'Generation failed'}</span>
              <code>{message.errorCode ?? 'generation-failed'}</code>
              <small>{message.errorCode === 'generation-cancelled' ? 'Your request was kept and can be submitted again.' : 'Your request was kept and can be retried.'}</small>
              {message.originalPrompt && <button className="text-action" disabled={sending} onClick={() => onRetry(message.originalPrompt!)}><RefreshCw size={13} />Retry</button>}
            </div>
            {message.modelFeedback && <p className="assistant-text generation-response failure-response">{message.modelFeedback}</p>}
          </>
        ) : <p className="assistant-text">{message.content}</p>}
      </div>
    </article>
  )
}

function PendingTurn({ translationEnabled }: { translationEnabled: boolean }) {
  return (
    <article className="assistant-message pending-turn"><div className="message-avatar agent-avatar"><Sparkles size={15} /></div><div className="assistant-content"><div className="message-meta"><strong>Galaxy Atelier</strong><span className="live-indicator"><span className="mini-dot green" /><span>Processing</span></span></div><PendingTrace translationEnabled={translationEnabled} /></div></article>
  )
}

function PendingTrace({ translationEnabled = true }: { translationEnabled?: boolean }) {
  return <div className="tool-trace"><div className="trace-step active"><span className="trace-icon"><LoaderCircle className="spin" size={12} /></span><span><b>{translationEnabled ? 'Refine prompt' : 'Submit original description directly'}</b><small>{translationEnabled ? 'The prompt model is processing your creative description' : 'Prompt model skipped; preparing the image API call'}</small></span></div><div className="trace-connector" /><div className="trace-step"><span className="trace-icon image-trace"><ImageIcon size={12} /></span><span><b>Image generation</b><small>Waiting for model call</small></span></div></div>
}

function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api.usage().then(setUsage).catch(reason => setError(errorText(reason))) }, [])
  return (
    <section className="data-page">
      <PageTitle eyebrow="ACCOUNT / USAGE" title="My Usage" subtitle="Image generation and prompt-model usage for this account." />
      {error && <InlineError>{error}</InlineError>}
      {!usage ? <PageLoading /> : <>
        <div className="metric-grid">
          <Metric label="Generation requests" value={number(usage.generations)} icon={<ImageIcon />} detail={`${number(usage.succeeded)} Succeeded · ${number(usage.failed - usage.cancelled)} Failed · ${number(usage.cancelled)} Stopped`} />
          <Metric label="Total cost" value={money(usage.costUsd)} icon={<Coins />} detail={costBreakdown(usage.translationTokenCostUsd, usage.imageTokenCostUsd, usage.imageRequestCostUsd, usage.unclassifiedCostUsd, true)} />
          <Metric label="Input tokens" value={number(usage.translationInputTokens + usage.imageInputTokens)} icon={<ArrowUp />} detail={`Translation ${number(usage.translationInputTokens)} · Image ${number(usage.imageInputTokens)}`} />
          <Metric label="Output tokens" value={number(usage.translationOutputTokens + usage.imageOutputTokens)} icon={<Sparkles />} detail={`Translation ${number(usage.translationOutputTokens)} · Image ${number(usage.imageOutputTokens)}`} />
        </div>
        <div className="data-section"><div className="section-heading"><div><h2>Request overview</h2><p>Includes all sessions and successful, failed, and user-stopped image requests for this account.</p></div></div><div className="usage-summary"><div><span>Sessions</span><strong>{number(usage.sessions)}</strong></div><div><span>Success rate</span><strong>{successRate(usage.succeeded, usage.failed, usage.cancelled)}</strong></div><div><span>Average response time</span><strong>{usage.averageDurationMs ? `${(usage.averageDurationMs / 1000).toFixed(1)}s` : '—'}</strong></div><div><span>Stopped by user</span><strong>{number(usage.cancelled)}</strong></div></div></div>
        <div className="data-section"><div className="section-heading"><div><h2>Model usage</h2><p>Grouped by actual image model, requested model, and prompt model.</p></div></div><ModelTable rows={usage.byModel} /></div>
      </>}
    </section>
  )
}

type TrafficRange = keyof AdminStats['traffic']

const trafficRangeOptions: Array<{ id: TrafficRange, label: string, description: string }> = [
  { id: 'minutes', label: 'Last 60 minutes', description: 'Minute-by-minute generation traffic.' },
  { id: 'hours', label: 'Last 24 hours', description: 'Hourly generation traffic for the last day.' },
  { id: 'days', label: 'Last 30 days', description: 'Daily generation traffic for the last month.' },
  { id: 'months', label: 'Last 12 months', description: 'Monthly generation traffic for the last year.' },
]

function legacyTrafficBuckets(data: AdminStats): TrafficBucket[] {
  return data.daily.map(day => ({
    bucket: day.day,
    start: `${day.day}T00:00:00.000Z`,
    end: `${day.day}T23:59:59.999Z`,
    accounts: 0,
    sessions: 0,
    generations: day.generations,
    succeeded: day.succeeded,
    failed: day.failed,
    cancelled: day.cancelled,
    averageDurationMs: 0,
    costUsd: day.costUsd,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    translationInputTokens: day.translationInputTokens,
    translationOutputTokens: day.translationOutputTokens,
    imageInputTokens: day.imageInputTokens,
    imageOutputTokens: day.imageOutputTokens,
    translationTokenCostUsd: day.translationTokenCostUsd,
    imageTokenCostUsd: day.imageTokenCostUsd,
    imageRequestCostUsd: day.imageRequestCostUsd,
    unclassifiedCostUsd: day.unclassifiedCostUsd,
  }))
}

function trafficBucketCounts(bucket: TrafficBucket): {
  succeeded: number
  failed: number
  cancelled: number
  pending: number
  total: number
} {
  const total = Math.max(0, bucket.generations)
  const failed = Math.max(0, Math.min(total, bucket.failed - bucket.cancelled))
  const succeeded = Math.max(0, Math.min(total, bucket.succeeded))
  const cancelled = Math.max(0, Math.min(total - succeeded - failed, bucket.cancelled))
  const pending = Math.max(0, total - succeeded - failed - cancelled)
  return { succeeded, failed, cancelled, pending, total }
}

function trafficBucketPeriodLabel(bucket: TrafficBucket, range: TrafficRange): string {
  const date = new Date(bucket.start)
  const locale = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en-US'
  if (range === 'months') return date.toLocaleDateString(locale, { month: 'short', year: 'numeric' })
  if (range === 'days') return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function trafficLabel(bucket: TrafficBucket, range: TrafficRange, index: number): string {
  const date = new Date(bucket.start)
  const locale = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en-US'
  if (range === 'minutes') {
    return index % 10 === 0 || index === 59
      ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : ''
  }
  if (range === 'hours') {
    return index % 3 === 0 || index === 23
      ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : ''
  }
  if (range === 'days') {
    return index % 5 === 0 || index === 29
      ? date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
      : ''
  }
  return index % 2 === 0 || index === 11
    ? date.toLocaleDateString(locale, { month: 'short', year: '2-digit' })
    : ''
}

function trafficBucketTitle(bucket: TrafficBucket, range: TrafficRange): string {
  const start = new Date(bucket.start)
  const end = new Date(bucket.end)
  const locale = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en-US'
  const formatOptions: Intl.DateTimeFormatOptions = range === 'months'
    ? { month: 'long', year: 'numeric' }
    : range === 'days'
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  const label = range === 'months'
    ? start.toLocaleDateString(locale, formatOptions)
    : `${start.toLocaleString(locale, formatOptions)} – ${end.toLocaleString(locale, formatOptions)}`
  const counts = trafficBucketCounts(bucket)
  return `${label} · ${number(counts.total)} requests (Success ${number(counts.succeeded)} / Failure ${number(counts.failed)} / Stop ${number(counts.cancelled)}${counts.pending ? ` / Pending ${number(counts.pending)}` : ''}) · ${number(bucket.accounts)} accounts · ${number(bucket.sessions)} sessions · ${money(bucket.costUsd)} · ${costBreakdown(bucket.translationTokenCostUsd, bucket.imageTokenCostUsd, bucket.imageRequestCostUsd, bucket.unclassifiedCostUsd, true)} · ${number(bucket.inputTokens)} input / ${number(bucket.outputTokens)} output tokens · Average ${durationLabel(bucket.averageDurationMs)}`
}

function AdminStatsPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const [data, setData] = useState<AdminStats | null>(null)
  const [error, setError] = useState('')
  const [trafficRange, setTrafficRange] = useState<TrafficRange>('days')
  useEffect(() => { api.adminStats().then(setData).catch(reason => setError(errorText(reason))) }, [])
  const selectedTraffic = useMemo(() => {
    if (!data) return []
    return data.traffic?.[trafficRange] ?? (trafficRange === 'days' ? legacyTrafficBuckets(data) : [])
  }, [data, trafficRange])
  const maxTraffic = useMemo(() => Math.max(1, ...selectedTraffic.map(item => item.generations)), [selectedTraffic])
  const trafficTotals = useMemo(() => selectedTraffic.reduce((totals, item) => ({
    generations: totals.generations + item.generations,
    succeeded: totals.succeeded + item.succeeded,
    failed: totals.failed + Math.max(0, item.failed - item.cancelled),
    cancelled: totals.cancelled + item.cancelled,
    inputTokens: totals.inputTokens + item.inputTokens,
    outputTokens: totals.outputTokens + item.outputTokens,
    costUsd: totals.costUsd + item.costUsd,
    durationMsWeighted: totals.durationMsWeighted + item.averageDurationMs * item.generations,
  }), { generations: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMsWeighted: 0 }), [selectedTraffic])
  const trafficInsights = useMemo(() => {
    const peak = selectedTraffic.reduce<TrafficBucket | null>((current, item) => (
      !current || item.generations > current.generations ? item : current
    ), null)
    return {
      peak,
      activeBuckets: selectedTraffic.filter(item => item.generations > 0).length,
      averagePerBucket: selectedTraffic.length ? trafficTotals.generations / selectedTraffic.length : 0,
      averageDurationMs: trafficTotals.generations ? trafficTotals.durationMsWeighted / trafficTotals.generations : 0,
    }
  }, [selectedTraffic, trafficTotals])
  const chartScaleValues = useMemo(() => [
    maxTraffic,
    Math.round(maxTraffic * .75),
    Math.round(maxTraffic * .5),
    Math.round(maxTraffic * .25),
    0,
  ], [maxTraffic])
  const chartValueStep = Math.max(1, Math.ceil(selectedTraffic.length / 12))
  const selectedTrafficRange = trafficRangeOptions.find(option => option.id === trafficRange) ?? trafficRangeOptions[2]
  const completedGenerations = data
    ? data.summary.succeeded + data.summary.failed - data.summary.cancelled
    : 0
  return (
    <section className="data-page">
      <AdminTabs page="stats" onNavigate={onNavigate} />
      <PageTitle eyebrow="ADMIN / OVERVIEW" title="Overview" subtitle="Service usage, model consumption, and account-level statistics." />
      {error && <InlineError>{error}</InlineError>}
      {!data ? <PageLoading /> : <>
        <div className="metric-grid stats-metric-grid">
          <Metric label="Active accounts" value={number(data.summary.activeUsers)} icon={<Users />} detail={`${number(data.summary.sessions)} Sessions`} />
          <Metric label="Generation requests" value={number(data.summary.generations)} icon={<ImageIcon />} detail={`${number(data.summary.succeeded)} Success · ${number(data.summary.failed - data.summary.cancelled)} Failure · ${number(data.summary.cancelled)} Stop`} />
          <Metric label="Estimated total cost" value={money(data.summary.costUsd)} icon={<Coins />} detail={costBreakdown(data.summary.translationTokenCostUsd, data.summary.imageTokenCostUsd, data.summary.imageRequestCostUsd, data.summary.unclassifiedCostUsd, true)} />
          <Metric label="Total tokens" value={number(data.summary.translationInputTokens + data.summary.translationOutputTokens + data.summary.imageInputTokens + data.summary.imageOutputTokens)} icon={<Activity />} detail="Input and output are recorded by model" />
          <Metric label="Success rate" value={successRate(data.summary.succeeded, data.summary.failed, data.summary.cancelled)} icon={<Check />} detail={`${number(completedGenerations)} completed requests, excluding user-stopped requests`} />
          <Metric label="Average response time" value={data.summary.averageDurationMs ? `${(data.summary.averageDurationMs / 1000).toFixed(1)}s` : '—'} icon={<Clock3 />} detail="Completed generation request average duration" />
        </div>
        <div className="data-section chart-section">
          <div className="section-heading traffic-heading">
            <div><h2>Generation traffic</h2><p>{selectedTrafficRange.description}</p></div>
            <div className="traffic-range-tabs" role="tablist" aria-label="Traffic time range">
              {trafficRangeOptions.map(option => <button key={option.id} type="button" role="tab" aria-selected={trafficRange === option.id} className={trafficRange === option.id ? 'active' : ''} onClick={() => setTrafficRange(option.id)}>{option.label}</button>)}
            </div>
          </div>
          <div className="traffic-summary" aria-live="polite">
            <span><strong>{number(trafficTotals.generations)}</strong> requests</span>
            <span className="traffic-summary-success"><i />{number(trafficTotals.succeeded)} succeeded</span>
            <span className="traffic-summary-failure"><i />{number(trafficTotals.failed)} failed</span>
            <span className="traffic-summary-stop"><i />{number(trafficTotals.cancelled)} stopped</span>
            <span className="traffic-summary-cost">{money(trafficTotals.costUsd)}</span>
          </div>
          <div className="traffic-insights" aria-label="Traffic highlights">
            <div className="traffic-insight"><span>Peak bucket</span><strong>{number(trafficInsights.peak?.generations)}</strong><small>{trafficInsights.peak ? trafficBucketPeriodLabel(trafficInsights.peak, trafficRange) : 'No activity'}</small></div>
            <div className="traffic-insight"><span>Average / bucket</span><strong>{trafficInsights.averagePerBucket.toFixed(1)}</strong><small>{number(trafficInsights.activeBuckets)} active of {number(selectedTraffic.length)}</small></div>
            <div className="traffic-insight"><span>Success rate</span><strong>{successRate(trafficTotals.succeeded, trafficTotals.failed + trafficTotals.cancelled, trafficTotals.cancelled)}</strong><small>{number(trafficTotals.succeeded)} completed successfully</small></div>
            <div className="traffic-insight"><span>Tokens</span><strong>{number(trafficTotals.inputTokens + trafficTotals.outputTokens)}</strong><small>{number(trafficTotals.inputTokens)} in · {number(trafficTotals.outputTokens)} out</small></div>
            <div className="traffic-insight"><span>Average response</span><strong>{durationLabel(trafficInsights.averageDurationMs)}</strong><small>Weighted by requests in range</small></div>
          </div>
          <div className="traffic-chart-frame">
            <div className="chart-scale" aria-hidden="true">
              {chartScaleValues.map((value, index) => <span key={`${value}-${index}`}>{number(value)}</span>)}
            </div>
            <div className="chart-plot">
              <div className="chart-grid-lines" aria-hidden="true">
                {chartScaleValues.map((_, index) => <span key={index} style={{ top: `${index / (chartScaleValues.length - 1) * 100}%` }} />)}
              </div>
              <div className="bar-chart">{selectedTraffic.map((bucket, index) => {
                const counts = trafficBucketCounts(bucket)
                const showBarValue = counts.total > 0 && (selectedTraffic.length <= 30 || counts.total === maxTraffic || index % chartValueStep === 0)
                const total = Math.max(1, counts.total)
                return <div className="chart-column" key={`${trafficRange}-${bucket.bucket}`} title={trafficBucketTitle(bucket, trafficRange)} tabIndex={0} role="img" aria-label={trafficBucketTitle(bucket, trafficRange)}>
                  {showBarValue && <strong className="chart-value">{number(counts.total)}</strong>}
                  <div className="chart-bar" style={{ height: `${Math.max(counts.total ? 9 : 2, counts.total / maxTraffic * 100)}%` }}>
                    {counts.total > 0 && <>
                      {counts.pending > 0 && <span className="chart-segment chart-segment-pending" style={{ height: `${counts.pending / total * 100}%` }} />}
                      {counts.failed > 0 && <span className="chart-segment chart-segment-failure" style={{ height: `${counts.failed / total * 100}%` }} />}
                      {counts.cancelled > 0 && <span className="chart-segment chart-segment-stop" style={{ height: `${counts.cancelled / total * 100}%` }} />}
                      {counts.succeeded > 0 && <span className="chart-segment chart-segment-success" style={{ height: `${counts.succeeded / total * 100}%` }} />}
                    </>}
                  </div>
                  <span>{trafficLabel(bucket, trafficRange, index)}</span>
                </div>
              })}
                {!selectedTraffic.length && <div className="chart-empty">No generation records</div>}
              </div>
            </div>
          </div>
          <div className="traffic-legend">
            <span><i className="traffic-dot traffic-dot-success" />Succeeded</span>
            <span><i className="traffic-dot traffic-dot-failure" />Failed</span>
            <span><i className="traffic-dot traffic-dot-stop" />Stopped</span>
            <span><i className="traffic-dot traffic-dot-pending" />Pending</span>
          </div>
          <div className="traffic-details">
            <div className="traffic-details-heading">
              <div><h3>Bucket details</h3><p>Newest periods first. Hover or focus a bar for the full period summary.</p></div>
              <span>{number(selectedTraffic.length)} buckets</span>
            </div>
            <div className="table-wrap traffic-detail-wrap">
              <table className="traffic-detail-table">
                <thead><tr><th>Period</th><th>Requests</th><th>Success</th><th>Failure</th><th>Stopped</th><th>Pending</th><th>Success rate</th><th>Accounts</th><th>Sessions</th><th>Tokens in / out</th><th>Cost</th><th>Avg response</th></tr></thead>
                <tbody>{[...selectedTraffic].reverse().map(bucket => {
                  const counts = trafficBucketCounts(bucket)
                  return <tr key={`detail-${trafficRange}-${bucket.bucket}`} title={trafficBucketTitle(bucket, trafficRange)}>
                    <td>{trafficBucketPeriodLabel(bucket, trafficRange)}</td>
                    <td><strong>{number(counts.total)}</strong></td>
                    <td className="traffic-detail-success">{number(counts.succeeded)}</td>
                    <td className="traffic-detail-failure">{number(counts.failed)}</td>
                    <td className="traffic-detail-stop">{number(counts.cancelled)}</td>
                    <td>{number(counts.pending)}</td>
                    <td>{successRate(counts.succeeded, counts.failed + counts.cancelled, counts.cancelled)}</td>
                    <td>{number(bucket.accounts)}</td>
                    <td>{number(bucket.sessions)}</td>
                    <td>{number(bucket.inputTokens)} / {number(bucket.outputTokens)}</td>
                    <td>{money(bucket.costUsd)}</td>
                    <td>{durationLabel(bucket.averageDurationMs)}</td>
                  </tr>
                })}</tbody>
              </table>
              {!selectedTraffic.length && <div className="table-empty">No generation records</div>}
            </div>
          </div>
        </div>
        <div className="data-section"><div className="section-heading"><div><h2>Account usage</h2><p>Split by account, success rate, model tokens, and estimated cost.</p></div></div><AccountTable rows={data.byUser} /></div>
        <div className="data-section"><div className="section-heading"><div><h2>Model consumption</h2><p>Grouped by image model and prompt model.</p></div></div><ModelTable rows={data.byModel} /></div>
        <div className="stats-breakdown-grid">
          <div className="data-section"><div className="section-heading"><div><h2>Generation modes</h2><p>Compare generation, original-image edits, and reference-image requests.</p></div></div><ModeTable rows={data.byMode} /></div>
          <div className="data-section"><div className="section-heading"><div><h2>Failure reasons</h2><p>Grouped by normalized server error code to troubleshoot configuration or provider issues.</p></div></div><ErrorTable rows={data.byError} /></div>
        </div>
      </>}
    </section>
  )
}

function UsersPage({ currentUserId, onSelfPasswordReset, onToast, onNavigate }: {
  currentUserId: string
  onSelfPasswordReset: () => void
  onToast: (value: string) => void
  onNavigate: (page: Page) => void
}) {
  const [users, setUsers] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resetAccountId, setResetAccountId] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [confirmResetPassword, setConfirmResetPassword] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    try { setUsers(await api.adminUsers()) } catch (reason) { setError(errorText(reason)) } finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])

  async function addUser(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.createUser(email, password, role)
      setEmail('')
      setPassword('')
      setRole('user')
      onToast('Account created')
      await refresh()
    } catch (reason) {
      setError(errorText(reason))
    } finally { setBusy(false) }
  }

  async function updateAccount(account: Account, values: { active?: boolean, role?: string }) {
    try {
      await api.updateUser(account.id, values)
      await refresh()
    } catch (reason) { onToast(errorText(reason)) }
  }

  async function deleteAccount(account: Account) {
    if (account.id === currentUserId || deleteBusyId) return
    const confirmed = window.confirm(`Permanently delete account ${account.email}? This account’s sessions, generation records, queue items, images, and login sessions will all be deleted and cannot be recovered.`)
    if (!confirmed) return
    setDeleteBusyId(account.id)
    try {
      await api.deleteUser(account.id)
      if (resetAccountId === account.id) closePasswordReset()
      onToast('The account and its data were deleted')
      await refresh()
    } catch (reason) {
      onToast(errorText(reason))
    } finally {
      setDeleteBusyId(null)
    }
  }

  function closePasswordReset() {
    setResetAccountId(null)
    setResetPassword('')
    setConfirmResetPassword('')
    setResetError('')
  }

  async function resetAccountPassword(event: FormEvent, account: Account) {
    event.preventDefault()
    if (resetPassword !== confirmResetPassword) {
      setResetError('The two passwords do not match')
      return
    }
    setResetBusy(true)
    setResetError('')
    try {
      await api.updateUser(account.id, { password: resetPassword })
      closePasswordReset()
      if (account.id === currentUserId) {
        onSelfPasswordReset()
      } else {
        onToast('Password reset. All existing sessions for this account were signed out.')
        await refresh()
      }
    } catch (reason) {
      setResetError(errorText(reason))
    } finally {
      setResetBusy(false)
    }
  }

  return (
    <section className="data-page">
      <AdminTabs page="users" onNavigate={onNavigate} />
      <PageTitle eyebrow="ADMIN / ACCOUNTS" title="Account management" subtitle="Create, disable, delete, and assign workspace permissions." />
      {error && <InlineError>{error}</InlineError>}
      <div className="data-section create-user-section">
        <div className="section-heading"><div><h2>Create account</h2><p>Initial passwords must be at least 8 characters and can be reset by an administrator.</p></div></div>
        <form className="create-user-form" onSubmit={addUser}>
          <label><span>Email</span><input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="user@example.com" /></label>
          <label><span>Initial password</span><input type="password" required minLength={8} value={password} onChange={event => setPassword(event.target.value)} placeholder="at least 8 characters" /></label>
          <label><span>Role</span><select value={role} onChange={event => setRole(event.target.value as 'user' | 'admin')}><option value="user">Member</option><option value="admin">Admin</option></select></label>
          <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Create account</button>
        </form>
      </div>
      <div className="data-section"><div className="section-heading"><div><h2>Workspace accounts</h2><p>{users.length} accounts · Last login times recorded in the server timezone</p></div><button className="icon-button refresh-button" title="Refresh" onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
        {loading ? <PageLoading /> : <div className="table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Generations</th><th>Cost</th><th>Last login</th><th>Actions</th></tr></thead><tbody>
          {users.map(account => <Fragment key={account.id}>
            <tr><td><div className="account-cell"><span className="table-avatar">{account.email.slice(0, 1).toUpperCase()}</span><span>{account.email}</span></div></td><td><select className="role-select" value={account.role} onChange={event => void updateAccount(account, { role: event.target.value })}><option value="user">Member</option><option value="admin">Admin</option></select></td><td><span className={`status-tag ${account.active ? 'enabled' : 'disabled'}`}><i />{account.active ? 'Enabled' : 'Disabled'}</span></td><td>{number(account.generationCount)}</td><td>{money(account.costUsd)}<small className="cost-breakdown">{costBreakdown(account.translationTokenCostUsd, account.imageTokenCostUsd, account.imageRequestCostUsd, account.unclassifiedCostUsd, true)}</small></td><td>{timeLabel(account.lastLoginAt)}</td><td><div className="account-actions"><button className="text-action" disabled={resetBusy || deleteBusyId !== null} onClick={() => { setResetError(''); setResetPassword(''); setConfirmResetPassword(''); setResetAccountId(current => current === account.id ? null : account.id) }}><KeyRound size={13} />Reset password</button><button className={`text-action ${account.active ? 'danger-text' : ''}`} disabled={deleteBusyId !== null} onClick={() => void updateAccount(account, { active: !account.active })}>{account.active ? 'Disabled' : 'Enabled'}</button>{account.id !== currentUserId && <button className="text-action danger-text" disabled={deleteBusyId !== null} onClick={() => void deleteAccount(account)}>{deleteBusyId === account.id ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}Delete</button>}</div></td></tr>
            {resetAccountId === account.id && <tr className="reset-password-row"><td colSpan={7}>
              <form className="reset-password-form" onSubmit={event => void resetAccountPassword(event, account)}>
                <label htmlFor={`reset-password-${account.id}`}>New password<input id={`reset-password-${account.id}`} type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={resetPassword} onChange={event => { setResetPassword(event.target.value); setResetError('') }} placeholder="at least 8 characters" /></label>
                <label htmlFor={`confirm-reset-password-${account.id}`}>Confirm new password<input id={`confirm-reset-password-${account.id}`} type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={confirmResetPassword} onChange={event => { setConfirmResetPassword(event.target.value); setResetError('') }} placeholder="Enter the new password again" /></label>
                <span className="reset-password-note">After reset, all signed-in devices for this account will be signed out.</span>
                <div className="reset-password-actions"><button className="primary-button" disabled={resetBusy}>{resetBusy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}Confirm reset</button><button className="text-action" type="button" disabled={resetBusy} onClick={closePasswordReset}>Cancel</button></div>
                {resetError && <span className="reset-password-error" role="alert">{resetError}</span>}
              </form>
            </td></tr>}
          </Fragment>)}
        </tbody></table>{!users.length && <div className="table-empty">No accounts</div>}</div>}
      </div>
    </section>
  )
}

function ProvidersPage({ onToast, onNavigate }: { onToast: (value: string) => void, onNavigate: (page: Page) => void }) {
  const [value, setValue] = useState<ProviderSettings | null>(null)
  const [translationKey, setTranslationKey] = useState('')
  const [imageKey, setImageKey] = useState('')
  const [clearTranslationKey, setClearTranslationKey] = useState(false)
  const [clearImageKey, setClearImageKey] = useState(false)
  const [savedProviders, setSavedProviders] = useState<{ translation: { baseUrl: string, model: string, systemPrompt: string }, image: { baseUrl: string, model: string } } | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<'translation' | 'image' | null>(null)
  const [testResults, setTestResults] = useState<Partial<Record<'translation' | 'image', { ok: boolean, message: string, model: string, availableModels: string[] }>>>({})
  const [modelOptions, setModelOptions] = useState<{ translation: string[], image: string[] }>({ translation: [], image: [] })
  const [error, setError] = useState('')
  useEffect(() => {
    api.providers().then(settings => {
      setValue(settings)
      setSavedProviders({
        translation: { baseUrl: settings.translation.baseUrl, model: settings.translation.model, systemPrompt: settings.translation.systemPrompt },
        image: { baseUrl: settings.image.baseUrl, model: settings.image.model },
      })
      if (settings.translation.configured || settings.image.configured) {
        void (async () => {
          if (settings.translation.configured) await fetchModels('translation', settings)
          if (settings.image.configured) await fetchModels('image', settings)
        })()
      }
    }).catch(reason => setError(errorText(reason)))
  }, [])

  function updateTranslation<K extends keyof ProviderSettings['translation']>(key: K, next: ProviderSettings['translation'][K]) {
    setValue(current => current ? { ...current, translation: { ...current.translation, [key]: next } } : current)
  }
  function updateImage<K extends keyof ProviderSettings['image']>(key: K, next: ProviderSettings['image'][K]) {
    setValue(current => current ? { ...current, image: { ...current.image, [key]: next } } : current)
  }
  async function fetchModels(provider: 'translation' | 'image', settings = value) {
    if (!settings) return
    setTesting(provider)
    setError('')
    try {
      const draft = provider === 'translation' ? settings.translation : settings.image
      const draftKey = provider === 'translation' ? translationKey : imageKey
      const result = await api.testProvider(provider, {
        baseUrl: draft.baseUrl,
        ...(draftKey ? { apiKey: draftKey } : {}),
      })
      setTestResults(current => ({ ...current, [provider]: result }))
      setModelOptions(current => ({ ...current, [provider]: result.availableModels }))
    } catch (reason) {
      setTestResults(current => ({ ...current, [provider]: { ok: false, message: errorText(reason), model: '', availableModels: [] } }))
      setModelOptions(current => ({ ...current, [provider]: [] }))
    } finally {
      setTesting(null)
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!value) return
    setSaving(true)
    setError('')
    try {
      const saved = await api.saveProviders({
        translation: {
          ...(translationKey ? { apiKey: translationKey } : {}),
          ...(clearTranslationKey ? { clearApiKey: true } : {}),
          baseUrl: value.translation.baseUrl,
          model: value.translation.model,
          systemPrompt: value.translation.systemPrompt,
          inputPricePerMillion: Number(value.translation.inputPricePerMillion),
          outputPricePerMillion: Number(value.translation.outputPricePerMillion),
        },
        image: {
          ...(imageKey ? { apiKey: imageKey } : {}),
          ...(clearImageKey ? { clearApiKey: true } : {}),
          baseUrl: value.image.baseUrl,
          model: value.image.model,
          inputPricePerMillion: Number(value.image.inputPricePerMillion),
          outputPricePerMillion: Number(value.image.outputPricePerMillion),
          costPerImage: Number(value.image.costPerImage),
        },
      })
      setValue(saved)
      setSavedProviders({
        translation: { baseUrl: saved.translation.baseUrl, model: saved.translation.model, systemPrompt: saved.translation.systemPrompt },
        image: { baseUrl: saved.image.baseUrl, model: saved.image.model },
      })
      setTranslationKey('')
      setImageKey('')
      setClearTranslationKey(false)
      setClearImageKey(false)
      setTestResults({})
      onToast('Provider configuration is encrypted and saved')
    } catch (reason) { setError(errorText(reason)) } finally { setSaving(false) }
  }

  return (
    <section className="data-page">
      <AdminTabs page="providers" onNavigate={onNavigate} />
      <PageTitle eyebrow="ADMIN / PROVIDERS" title="Models & keys" subtitle="Configure the site-wide prompt model and image-generation API." />
      {error && <InlineError>{error}</InlineError>}
      {!value ? <PageLoading /> : <form onSubmit={save}>
        <div className="provider-grid">
          <div className="data-section provider-section">
            <div className="provider-heading"><div className="provider-icon"><Sparkles size={18} /></div><div><h2>Prompt model</h2><p>Turn natural language into clear, executable English image prompts.</p></div><span className={`config-status ${value.translation.configured ? 'configured' : ''}`}><i />{value.translation.configured ? 'Configured' : 'Not configured'}</span><button type="button" className="text-action provider-test-button" disabled={(!value.translation.configured && !translationKey.trim()) || clearTranslationKey || testing !== null} onClick={() => void fetchModels('translation')} title="Fetch the model list from the compatible API">{testing === 'translation' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Fetch models</button></div>
            <label className="field-label">Compatible API URL <input type="url" maxLength={1000} value={value.translation.baseUrl} onChange={event => updateTranslation('baseUrl', event.target.value)} placeholder="https://translation-provider.example/v1" required /></label>
            <label className="field-label">Model name
              <div className="model-picker">
                <select aria-label="Choose a fetched prompt model" value={modelOptions.translation.includes(value.translation.model) ? value.translation.model : ''} onChange={event => { if (event.target.value) updateTranslation('model', event.target.value) }} disabled={modelOptions.translation.length === 0}>
                  <option value="">{modelOptions.translation.length ? 'Choose from fetched models' : 'Fetch models to choose from the list'}</option>
                  {[...new Set(modelOptions.translation)].map(model => <option key={model} value={model}>{model}</option>)}
                </select>
                <input maxLength={180} value={value.translation.model} onChange={event => updateTranslation('model', event.target.value)} placeholder={modelOptions.translation.length ? 'You can also enter a custom model ID' : 'Enter a model ID returned by the compatible API'} required />
              </div>
              {modelOptions.translation.length > 0 && <small className="model-picker-note">Fetched {modelOptions.translation.length} models. Choose one from the dropdown.</small>}
            </label>
            <label className="field-label">System prompt <textarea className="system-prompt-input" maxLength={50000} value={value.translation.systemPrompt} onChange={event => updateTranslation('systemPrompt', event.target.value)} spellCheck={false} /><small className="model-picker-note">Constrains the prompt model’s role, output format, and image-context handling rules. Leave blank to restore the default AGENT.md.</small></label>
            <label className="field-label">API key <input type="password" autoComplete="new-password" value={translationKey} onChange={event => { setTranslationKey(event.target.value); setClearTranslationKey(false) }} placeholder={value.translation.configured ? 'Saved. Leave blank to keep the current value.' : 'Paste the prompt-model API key'} /></label>
            {value.translation.configured && <label className="clear-key"><input type="checkbox" checked={clearTranslationKey} onChange={event => { setClearTranslationKey(event.target.checked); if (event.target.checked) setTranslationKey('') }} />Clear saved key</label>}
            <div className="price-fields"><label className="field-label">Input price / 1M tokens <input type="number" min="0" step="0.000001" value={value.translation.inputPricePerMillion} onChange={event => updateTranslation('inputPricePerMillion', Number(event.target.value))} /></label><label className="field-label">Output price / 1M tokens <input type="number" min="0" step="0.000001" value={value.translation.outputPricePerMillion} onChange={event => updateTranslation('outputPricePerMillion', Number(event.target.value))} /></label></div>
            {testResults.translation && <div className={`provider-test-result ${testResults.translation.ok ? 'success' : 'failure'}`}><span>{testResults.translation.message}</span>{testResults.translation.model && <code>{testResults.translation.model}</code>}</div>}
          </div>
          <div className="data-section provider-section">
            <div className="provider-heading"><div className="provider-icon image-provider"><ImageIcon size={18} /></div><div><h2>Image model</h2><p>Generate an image from the refined prompt and return it to the current session.</p></div><span className={`config-status ${value.image.configured ? 'configured' : ''}`}><i />{value.image.configured ? 'Configured' : 'Not configured'}</span><button type="button" className="text-action provider-test-button" disabled={(!value.image.configured && !imageKey.trim()) || clearImageKey || testing !== null} onClick={() => void fetchModels('image')} title="Fetch the model list from the compatible API">{testing === 'image' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Fetch models</button></div>
            <label className="field-label">Compatible API URL <input type="url" maxLength={1000} value={value.image.baseUrl} onChange={event => updateImage('baseUrl', event.target.value)} placeholder="https://image-provider.example/v1" required /></label>
            <label className="field-label">Model name
              <div className="model-picker">
                <select aria-label="Choose a fetched image model" value={modelOptions.image.includes(value.image.model) ? value.image.model : ''} onChange={event => { if (event.target.value) updateImage('model', event.target.value) }} disabled={modelOptions.image.length === 0}>
                  <option value="">{modelOptions.image.length ? 'Choose from fetched models' : 'Fetch models to choose from the list'}</option>
                  {[...new Set(modelOptions.image)].map(model => <option key={model} value={model}>{model}</option>)}
                </select>
                <input maxLength={180} value={value.image.model} onChange={event => updateImage('model', event.target.value)} placeholder={modelOptions.image.length ? 'You can also enter a custom model ID' : 'Enter a model ID returned by the compatible API'} required />
              </div>
              {modelOptions.image.length > 0 && <small className="model-picker-note">Fetched {modelOptions.image.length} models. Choose one from the dropdown.</small>}
            </label>
            <label className="field-label">API key <input type="password" autoComplete="new-password" value={imageKey} onChange={event => { setImageKey(event.target.value); setClearImageKey(false) }} placeholder={value.image.configured ? 'Saved. Leave blank to keep the current value.' : 'Paste the image-generation API key'} /></label>
            {value.image.configured && <label className="clear-key"><input type="checkbox" checked={clearImageKey} onChange={event => { setClearImageKey(event.target.checked); if (event.target.checked) setImageKey('') }} />Clear saved key</label>}
            <div className="price-fields">
              <label className="field-label">Input price / 1M tokens <input type="number" min="0" step="0.000001" value={value.image.inputPricePerMillion} onChange={event => updateImage('inputPricePerMillion', Number(event.target.value))} /></label>
              <label className="field-label">Output price / 1M tokens <input type="number" min="0" step="0.000001" value={value.image.outputPricePerMillion} onChange={event => updateImage('outputPricePerMillion', Number(event.target.value))} /></label>
            <label className="field-label">Cost per image / USD <input type="number" min="0" step="0.0001" value={value.image.costPerImage} onChange={event => updateImage('costPerImage', Number(event.target.value))} /></label>
            </div>
            {testResults.image && <div className={`provider-test-result ${testResults.image.ok ? 'success' : 'failure'}`}><span>{testResults.image.message}</span>{testResults.image.model && <code>{testResults.image.model}</code>}{testResults.image.availableModels.length > 0 && <small>Found {testResults.image.availableModels.length} models available in the model-name selector.</small>}</div>}
          </div>
        </div>
        <div className="provider-save-row"><div><Shield size={15} />Keys are AES-256-GCM encrypted and stored on the server</div><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Save configuration</button></div>
      </form>}
    </section>
  )
}

function LogsPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const [logs, setLogs] = useState<AuditLog[] | null>(null)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [deletingLogId, setDeletingLogId] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [filters, setFilters] = useState({ email: '', event: '', status: '' as '' | 'success' | 'failure' })
  const [draftFilters, setDraftFilters] = useState(filters)
  const pageSize = 100

  async function refreshLogs(activeFilters = filters) {
    setRefreshing(true)
    setError('')
    try {
      const page = await api.logs({ limit: pageSize, ...activeFilters })
      setLogs(page)
      setHasMore(page.length === pageSize)
    } catch (reason) {
      setError(errorText(reason))
      setLogs(current => current ?? [])
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { void refreshLogs() }, [])

  function applyFilters(event: FormEvent) {
    event.preventDefault()
    setFilters(draftFilters)
    void refreshLogs(draftFilters)
  }

  async function loadOlderLogs() {
    const before = logs?.at(-1)?.id
    if (!before || loadingMore || refreshing || !hasMore) return
    setLoadingMore(true)
    setError('')
    try {
      const page = await api.logs({ limit: pageSize, before, ...filters })
      setLogs(current => [...(current ?? []), ...page])
      setHasMore(page.length === pageSize)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoadingMore(false)
    }
  }

  async function exportLogs() {
    setExporting(true)
    setError('')
    try {
      const blob = await api.logsExport(filters)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setExporting(false)
    }
  }

  async function deleteLog(log: AuditLog) {
    if (!window.confirm('Delete this audit log?')) return
    setDeletingLogId(log.id)
    setError('')
    try {
      await api.deleteLog(log.id)
      await refreshLogs()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setDeletingLogId(null)
    }
  }

  return (
    <section className="data-page">
      <AdminTabs page="logs" onNavigate={onNavigate} />
      <PageTitle eyebrow="ADMIN / AUDIT" title="Audit logs" subtitle="Login, account management, model request status, and usage activity." />
      {error && <InlineError>{error}</InlineError>}
      {!logs ? <PageLoading /> : <div className="data-section logs-section"><div className="section-heading"><div><h2>Recent events</h2><p>API keys and full prompts are not written to audit logs.</p></div><div className="log-controls"><span className="log-count">{logs.length} EVENTS</span><button className="secondary-button" type="button" disabled={exporting || refreshing} onClick={() => void exportLogs()} title="Export all logs matching the current filters">{exporting ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}Export CSV</button><button className="icon-button refresh-button" aria-label="Refresh logs" title="Refresh logs" disabled={refreshing || exporting} onClick={() => void refreshLogs()}><RefreshCw size={14} className={refreshing ? 'spin' : ''} /></button></div></div>
        <form className="log-filter-form" onSubmit={applyFilters}>
          <label><span>Account email</span><input type="search" maxLength={254} value={draftFilters.email} onChange={event => setDraftFilters(current => ({ ...current, email: event.target.value }))} placeholder="Filter by account" /></label>
          <label><span>Event</span><input type="search" maxLength={120} value={draftFilters.event} onChange={event => setDraftFilters(current => ({ ...current, event: event.target.value }))} placeholder="e.g. generation.failed" /></label>
          <label><span>Result</span><select value={draftFilters.status} onChange={event => setDraftFilters(current => ({ ...current, status: event.target.value as typeof current.status }))}><option value="">All</option><option value="success">Success</option><option value="failure">Failure</option></select></label>
          <button className="secondary-button" disabled={refreshing}><Search size={14} />Filter</button>
        </form>
        <div className="logs-list">{logs.map(log => <article className="log-row" key={log.id}><span className={`log-icon ${log.status === 'failure' ? 'log-failed' : ''}`}>{log.status === 'failure' ? <AlertCircle size={15} /> : <Activity size={15} />}</span><div className="log-main"><div className="log-title"><strong>{log.event}</strong><span className={`log-status ${log.status}`}>{log.status === 'success' ? 'Success' : 'Failure'}</span></div><div className="log-detail"><span>{log.email ?? 'System'}</span><code>{JSON.stringify(log.details)}</code></div></div><div className="log-side"><time>{timeLabel(log.createdAt)}</time><code>{log.requestId.slice(0, 8)}</code><button className="icon-button log-delete-button" type="button" aria-label="Delete log" title="Delete log" disabled={deletingLogId !== null || refreshing || exporting} onClick={() => void deleteLog(log)}>{deletingLogId === log.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></div></article>)}
          {!logs.length && <div className="table-empty">No logs</div>}
          {hasMore && <div className="logs-more"><button disabled={loadingMore || refreshing} onClick={() => void loadOlderLogs()}>{loadingMore ? <LoaderCircle className="spin" size={14} /> : null}{loadingMore ? 'Loading' : 'Load older logs'}</button></div>}</div>
      </div>}
    </section>
  )
}

function AdminTabs({ page, onNavigate }: { page: Page, onNavigate: (page: Page) => void }) {
  const tabs: Array<{ id: Page, icon: React.ReactNode }> = [
    { id: 'stats', icon: <BarChart3 size={15} /> },
    { id: 'users', icon: <Users size={15} /> },
    { id: 'providers', icon: <KeyRound size={15} /> },
    { id: 'logs', icon: <ScrollText size={15} /> },
  ]
  return <nav className="admin-tabs" aria-label="Admin functions">{tabs.map(tab => <button key={tab.id} className={page === tab.id ? 'selected' : ''} onClick={() => onNavigate(tab.id)}>{tab.icon}{pageLabels[tab.id]}</button>)}</nav>
}

function PageTitle({ eyebrow, title, subtitle }: { eyebrow: string, title: string, subtitle: string }) {
  return <div className="page-title"><div className="section-kicker">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>
}

function Metric({ label, value, icon, detail }: { label: string, value: string, icon: React.ReactNode, detail: string }) {
  return <div className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></div>
}

function AccountTable({ rows }: { rows: AdminStats['byUser'] }) {
  return <div className="table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Sessions</th><th>Requests</th><th>Success / Failure / Stop</th><th>Success rate</th><th>Translation input / output</th><th>Image input / output</th><th>Cost</th><th>Average duration</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{row.email}</td><td>{row.role === 'admin' ? 'Admin' : 'Member'}</td><td>{number(row.sessions)}</td><td>{number(row.generations)}</td><td>{number(row.succeeded)} / {number(row.failed - row.cancelled)} / {number(row.cancelled)}</td><td>{successRate(row.succeeded, row.failed, row.cancelled)}</td><td>{number(row.translationInputTokens)} / {number(row.translationOutputTokens)}</td><td>{number(row.imageInputTokens)} / {number(row.imageOutputTokens)}</td><td>{money(row.costUsd)}<small className="cost-breakdown">{costBreakdown(row.translationTokenCostUsd, row.imageTokenCostUsd, row.imageRequestCostUsd, row.unclassifiedCostUsd, true)}</small></td><td>{row.averageDurationMs ? `${(row.averageDurationMs / 1000).toFixed(1)}s` : '—'}</td></tr>)}</tbody></table>{!rows.length && <div className="table-empty">No usage data</div>}</div>
}

function ModelTable({ rows }: { rows: ModelUsage[] }) {
  return <div className="table-wrap"><table><thead><tr><th>Actual image model</th><th>Prompt model</th><th>Sessions</th><th>Requests</th><th>Success / Failure / Stop</th><th>Success rate</th><th>Translation input tokens</th><th>Translation output tokens</th><th>Image input tokens</th><th>Image output tokens</th><th>Cost</th><th>Average duration</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.imageModel}:${row.requestedImageModel}:${row.translationModel}`}><td><code>{row.imageModel}</code>{row.fallbackFrom && <small className="model-origin">Fallback from {row.fallbackFrom}</small>}</td><td><code>{row.translationModel}</code></td><td>{number(row.sessions)}</td><td>{number(row.generations)}</td><td>{number(row.succeeded)} / {number(row.failed - row.cancelled)} / {number(row.cancelled)}</td><td>{successRate(row.succeeded, row.failed, row.cancelled)}</td><td>{number(row.translationInputTokens)}</td><td>{number(row.translationOutputTokens)}</td><td>{number(row.imageInputTokens)}</td><td>{number(row.imageOutputTokens)}</td><td>{money(row.costUsd)}<small className="cost-breakdown">{costBreakdown(row.translationTokenCostUsd, row.imageTokenCostUsd, row.imageRequestCostUsd, row.unclassifiedCostUsd, true)}</small></td><td>{row.averageDurationMs ? `${(row.averageDurationMs / 1000).toFixed(1)}s` : '—'}</td></tr>)}</tbody></table>{!rows.length && <div className="table-empty">No model usage</div>}</div>
}

function ModeTable({ rows }: { rows: AdminStats['byMode'] }) {
  const labels: Record<AdminStats['byMode'][number]['imageMode'], string> = {
    generation: 'Generation',
    edit: 'Edit original',
    reference: 'Visual reference',
  }
  return <div className="table-wrap"><table><thead><tr><th>Mode</th><th>Requests</th><th>Success / Failure / Stop</th><th>Success rate</th><th>Reference image bytes</th><th>Cost</th><th>Average duration</th></tr></thead><tbody>{rows.map(row => <tr key={row.imageMode}><td>{labels[row.imageMode] ?? row.imageMode}</td><td>{number(row.generations)}</td><td>{number(row.succeeded)} / {number(row.failed)} / {number(row.cancelled)}</td><td>{successRate(row.succeeded, row.failed + row.cancelled, row.cancelled)}</td><td>{number(row.referenceImageBytes)}</td><td>{money(row.costUsd)}</td><td>{row.averageDurationMs ? `${(row.averageDurationMs / 1000).toFixed(1)}s` : '—'}</td></tr>)}</tbody></table>{!rows.length && <div className="table-empty">No mode data</div>}</div>
}

function ErrorTable({ rows }: { rows: AdminStats['byError'] }) {
  return <div className="table-wrap"><table><thead><tr><th>Error code</th><th>Requests</th><th>Success / Failure / Stop</th></tr></thead><tbody>{rows.map(row => <tr key={row.errorCode}><td><code>{row.errorCode}</code></td><td>{number(row.generations)}</td><td>{number(row.succeeded)} / {number(row.failed)} / {number(row.cancelled)}</td></tr>)}</tbody></table>{!rows.length && <div className="table-empty">No error data</div>}</div>
}

function InlineError({ children }: { children: string }) {
  return <div className="inline-error"><AlertCircle size={15} />{children}</div>
}

function PageLoading() {
  return <div className="page-loading"><LoaderCircle className="spin" size={18} />Loading</div>
}
