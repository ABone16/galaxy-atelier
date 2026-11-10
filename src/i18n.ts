export type Language = 'en' | 'zh'

export function detectBrowserLanguage(): Language {
  if (typeof navigator === 'undefined') return 'en'
  const candidates = [...(navigator.languages ?? []), navigator.language]
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase().replace('_', '-')
    if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh'
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  }
  return 'en'
}

const zhToEnglish: Record<string, string> = {
  '我的用量': 'My Usage',
  '运营概览': 'Overview',
  '账号管理': 'Account management',
  '模型与密钥': 'Models & keys',
  '操作日志': 'Audit logs',
  '跟随系统': 'Follow system',
  '青绿': 'Teal',
  '银河': 'Galaxy',
  '银河青绿': 'Galaxy Teal',
  '纸张': 'Paper',
  '海岸': 'Ocean',
  '夕照': 'Sunset',
  '午夜': 'Midnight',
  '深林': 'Forest',
  '李子': 'Plum',
  '石墨': 'Graphite',
  'Galaxy 青绿': 'Galaxy Teal',
  'Paper 纸张': 'Paper',
  'Ocean 海岸': 'Ocean',
  'Sunset 夕照': 'Sunset',
  'Midnight 午夜': 'Midnight',
  'Forest 深林': 'Forest',
  'Plum 李子': 'Plum',
  'Graphite 石墨': 'Graphite',
  '中文': 'Chinese',
  'English': 'English',
  '语言': 'Language',
  '切换语言': 'Change language',
  '显示密码': 'Show password',
  '隐藏密码': 'Hide password',
  '生成图像': 'Generated image',
  '历史未分类': 'Unclassified history',
  '翻译': 'Translation',
  '生图': 'Image',
  '调用': 'Request',
  '模型决定': 'Model decides',
  '正方形': 'Square',
  '竖版': 'Portrait',
  '横版默认': 'Landscape',
  '从未登录': 'Never logged in',
  '操作失败，请稍后重试': 'Something went wrong. Please try again.',
  '切换界面主题': 'Change theme',
  '界面主题': 'Interface theme',
  '密码已重置，所有现有登录会话已退出。请使用新密码登录。': 'Password reset. Existing sessions were signed out. Please log in with the new password.',
  '会话已归档': 'Session archived',
  '会话已恢复': 'Session restored',
  '首选模型不可用，本次已明确回退到': 'The preferred model was unavailable. This request explicitly fell back to',
  '已加入当前会话队列': 'Added to the current session queue',
  '已载入生成图，请描述想修改的内容': 'Image loaded. Describe what you want to change.',
  '已请求停止当前生成': 'Stop requested for the current generation',
  '收起侧栏': 'Collapse sidebar',
  '展开侧栏': 'Expand sidebar',
  '新建图像会话': 'New image session',
  '会话筛选': 'Session filter',
  '最近': 'Recent',
  '已归档': 'Archived',
  '关闭搜索': 'Close search',
  '搜索会话': 'Search sessions',
  '搜索会话或描述': 'Search sessions or descriptions',
  '搜索会话名称或历史描述': 'Search session names or history',
  '清除搜索': 'Clear search',
  '会话名称': 'Session name',
  '保存名称': 'Save name',
  '正在搜索…': 'Searching…',
  '搜索失败': 'Search failed',
  '没有匹配的会话': 'No matching sessions',
  '还没有会话': 'No sessions yet',
  '图像工作台': 'Image Studio',
  '管理': 'Admin',
  '管理员': 'Admin',
  '成员': 'Member',
  '退出登录': 'Sign out',
  '关闭侧栏': 'Close sidebar',
  '正在生成': 'Generating',
  '会话操作': 'Session actions',
  '重命名': 'Rename',
  '归档会话': 'Archive session',
  '把想象，': 'Turn imagination',
  '变成图像。': 'into images.',
  '用自然语言开始创作。你的会话、生成记录与用量始终属于你的账号。': 'Create with natural language. Your sessions, generations, and usage stay in your account.',
  '登录工作区': 'Sign in to workspace',
  '使用管理员创建的账号继续。': 'Continue with an account created by an administrator.',
  '邮箱': 'Email',
  '密码': 'Password',
  '输入密码': 'Enter password',
  '进入工作区': 'Enter workspace',
  '正在检查并转换图片…': 'Checking and converting image…',
  '创作一张新图像': 'Create a new image',
  '恢复会话': 'Restore session',
  '正在恢复会话': 'Restoring session',
  '描述一幅画面，': 'Describe a scene,',
  '从这里开始。': 'and start here.',
  '自然语言会先整理为图像提示词，再提交给生图模型。': 'Natural language is refined into an image prompt before it is sent to the image model.',
  '创建独立会话': 'Create standalone session',
  '正在加载': 'Loading',
  '加载更早消息': 'Load older messages',
  '回到最新消息': 'Jump to latest',
  '此会话已归档，当前为只读状态。恢复后即可继续生成。': 'This session is archived and read-only. Restore it to continue generating.',
  '松开以上传图片': 'Drop to upload image',
  '参考图用途': 'Reference image purpose',
  '编辑原图': 'Edit original',
  '参考画面': 'Visual reference',
  '移除参考图': 'Remove reference image',
  '选择参考图': 'Choose reference image',
  '描述你想生成的图像...': 'Describe the image you want to create...',
  '添加参考图': 'Add reference image',
  '参考图模式沿用原图方向': 'Reference mode follows the original orientation',
  '输出画幅': 'Output aspect ratio',
  '图像比例': 'Image aspect ratio',
  '先用翻译模型整理英文提示词': 'Use the prompt model to refine an English prompt first',
  '跳过翻译模型，直接发送用户文字': 'Skip the prompt model and send the user text directly',
  '翻译模型': 'Prompt model',
  '用户文字': 'User text',
  '停止生成': 'Stop generation',
  '加入生成队列': 'Add to generation queue',
  '待处理生成队列': 'Pending generation queue',
  '待处理队列': 'Pending queue',
  '当前请求完成后依次处理': 'Processed after the current request completes',
  '编辑队列提示词': 'Edit queued prompt',
  '使用翻译模型': 'Use prompt model',
  '跳过翻译': 'Skip prompt model',
  '取消编辑': 'Cancel editing',
  '保存提示词': 'Save prompt',
  '移入输入框': 'Move to input',
  '移除队列项': 'Remove queue item',
  '关闭预览': 'Close preview',
  '耗时': 'Duration',
  '图像生成': 'Image generation',
  '等待模型调用': 'Waiting for model call',
  '处理中': 'Processing',
  '停止': 'Stop',
  '生成提示词': 'Generated prompt',
  '模型修订': 'Model revision',
  '放大预览图片': 'Enlarge image preview',
  '用户上传的编辑原图': 'User-uploaded edit image',
  '用户上传的参考图': 'User-uploaded reference image',
  '用户上传的图片': 'User-uploaded image',
  '用此图继续编辑': 'Continue editing with this image',
  '正在载入图像': 'Loading image',
  '下载图像：': 'Download image: ',
  '放大预览': 'Enlarge preview',
  '已完成': 'Completed',
  '已停止生成': 'Generation stopped',
  '生成失败': 'Generation failed',
  '提交内容已保留，可以重新提交。': 'Your request was kept and can be submitted again.',
  '提交内容已保留，可以重试。': 'Your request was kept and can be retried.',
  '重试': 'Retry',
  '整理提示词': 'Refine prompt',
  '翻译模型正在处理创作描述': 'The prompt model is processing your creative description',
  '跳过翻译模型，准备调用图像 API': 'Prompt model skipped; preparing the image API call',
  '当前账号的图像生成与翻译模型消耗。': 'Image generation and prompt-model usage for this account.',
  '生成请求': 'Generation requests',
  '累计费用': 'Total cost',
  '输入 Token': 'Input tokens',
  '输出 Token': 'Output tokens',
  '请求概况': 'Request overview',
  '会话': 'Sessions',
  '成功率': 'Success rate',
  '平均响应时间': 'Average response time',
  '主动停止': 'Stopped by user',
  '模型用量': 'Model usage',
  '启用账号': 'Active accounts',
  '累计估算费用': 'Estimated total cost',
  '累计 Token': 'Total tokens',
  '按模型分别记录输入与输出': 'Input and output are recorded by model',
  '最近 30 天': 'Last 30 days',
  '按日统计生成量和费用归属。': 'Daily generation volume and cost attribution.',
  '生成流量': 'Generation traffic',
  '最近 60 分钟': 'Last 60 minutes',
  '最近 24 小时': 'Last 24 hours',
  '最近 12 个月': 'Last 12 months',
  '按分钟统计最近一小时的生图流量。': 'Minute-by-minute generation traffic.',
  '按小时统计最近一天的生图流量。': 'Hourly generation traffic for the last day.',
  '按日统计最近一个月的生图流量。': 'Daily generation traffic for the last month.',
  '按月统计最近一年的生图流量。': 'Monthly generation traffic for the last year.',
  '流量时间范围': 'Traffic time range',
  '待处理': 'Pending',
  '账号用量': 'Account usage',
  '模型消耗': 'Model consumption',
  '生成模式': 'Generation modes',
  '失败原因': 'Failure reasons',
  '创建账号': 'Create account',
  '初始密码': 'Initial password',
  '角色': 'Role',
  '工作区账号': 'Workspace accounts',
  '刷新': 'Refresh',
  '状态': 'Status',
  '生成': 'Generations',
  '费用': 'Cost',
  '最后登录': 'Last login',
  '操作': 'Actions',
  '启用': 'Enabled',
  '停用': 'Disabled',
  '重置密码': 'Reset password',
  '删除': 'Delete',
  '新密码': 'New password',
  '确认新密码': 'Confirm new password',
  '确认重置': 'Confirm reset',
  '取消': 'Cancel',
  '暂无账号': 'No accounts',
  '提示词翻译模型': 'Prompt model',
  '图像生成模型': 'Image model',
  '已配置': 'Configured',
  '待配置': 'Not configured',
  '获取模型': 'Fetch models',
  '兼容 API 地址': 'Compatible API URL',
  '模型名称': 'Model name',
  '从已获取列表选择': 'Choose from fetched models',
  '获取后可从列表选择': 'Fetch models to choose from the list',
  '也可手动输入自定义模型 ID': 'You can also enter a custom model ID',
  '输入兼容 API 返回的模型 ID': 'Enter a model ID returned by the compatible API',
  '系统提示词': 'System prompt',
  '清除已保存的密钥': 'Clear saved key',
  '保存配置': 'Save configuration',
  '最近事件': 'Recent events',
  '导出 CSV': 'Export CSV',
  '账号邮箱': 'Account email',
  '事件': 'Event',
  '结果': 'Result',
  '全部': 'All',
  '筛选': 'Filter',
  '成功': 'Success',
  '失败': 'Failure',
  '暂无日志': 'No logs',
  '加载更早日志': 'Load older logs',
  '管理员功能': 'Admin functions',
  '错误码': 'Error code',
  '暂无用量数据': 'No usage data',
  '暂无模型用量': 'No model usage',
  '暂无模式数据': 'No mode data',
  '暂无错误数据': 'No error data',
  '加载中': 'Loading',
  '纯生成': 'Generation',
  '没有归档会话': 'No archived sessions',
  '请求失败': 'Request failed',
  '归档状态无效': 'Archive status is invalid',
  '会话操作：': 'Session actions: ',
  '图片模型：': 'Image model: ',
  '已生成图像': 'Generated image',
  '名称：': 'Name: ',
  '模型：': 'Model: ',
  '已成功': 'Succeeded',
  '已失败': 'Failed',
  '已停止': 'Stopped',
  '完成的生成请求平均耗时': 'Completed generation request average duration',
  '上次登录时间记录在服务器时区': 'Last login times recorded in the server timezone',
  '两个密码不匹配': 'The two passwords do not match',
  '再次输入新密码': 'Enter the new password again',
  '账号及其数据已删除': 'The account and its data were deleted',
  '提供商配置已加密并保存': 'Provider configuration is encrypted and saved',
  '选择获取的提示词模型': 'Choose a fetched prompt model',
  '按账号筛选': 'Filter by account',
  '每张图片费用': 'Cost per image / USD',
  '请求数': 'Requests',
  '翻译输入 / 输出': 'Translation input / output',
  '图像输入 / 输出': 'Image input / output',
  '平均耗时': 'Average duration',
  '提示词代理': 'Prompt Agent',
  '图像 API': 'Image API',
  '图像': 'Image',
  '生成图像操作': 'Generate image',
  '无法读取参考图': 'Unable to read the reference image',
  '请选择图像文件': 'Please choose an image file',
  '参考图不能超过 10 MiB': 'Reference image must not exceed 10 MiB',
  '无法读取图像。请确认文件未损坏且浏览器支持此格式。': 'Unable to read the image. Confirm the file is not corrupted and that your browser supports this format.',
  '参考图尺寸无效或过大': 'Reference image dimensions are invalid or too large',
  '此浏览器不支持图像转换': 'This browser does not support image conversion',
  '转换后的 PNG 超过 10 MiB': 'Converted PNG exceeds 10 MiB',
  '当前会话已有生成任务正在进行': 'The current session already has a generation in progress',
  '生成图像格式无效，无法载入编辑': 'Generated image format is invalid and cannot be loaded for editing',
  '生成图像超过 10 MiB，无法作为编辑参考图': 'Generated image exceeds 10 MiB and cannot be used as an edit reference',
  '东京雨夜的唱片店，胶片摄影': 'A Tokyo record store on a rainy night, film photography',
  '漂浮在云层上方的玻璃温室，超现实主义': 'A glass greenhouse floating above the clouds, surrealism',
  '海边灯塔旅行海报，复古丝网印刷': 'A seaside lighthouse travel poster, vintage screen print',
  '服务使用、模型消耗和账号级统计。': 'Service usage, model consumption, and account-level statistics.',
  '账号已创建': 'Account created',
  '密码已重置。该账号的所有现有会话均已退出。': 'Password reset. All existing sessions for this account were signed out.',
  '创建、停用、删除账号并分配工作区权限。': 'Create, disable, delete, and assign workspace permissions.',
  '从兼容 API 获取模型列表': 'Fetch the model list from the compatible API',
  '选择获取的图像模型': 'Choose a fetched image model',
  '保存的密钥。留空以保留当前值。': 'Saved. Leave blank to keep the current value.',
  '粘贴提示词模型 API 密钥': 'Paste the prompt-model API key',
  '粘贴图像生成 API 密钥': 'Paste the image-generation API key',
  '登录、账号管理、模型请求状态和用量活动。': 'Login, account management, model request status, and usage activity.',
  '导出当前筛选条件匹配的所有日志': 'Export all logs matching the current filters',
  '刷新日志': 'Refresh logs',
  '删除日志': 'Delete log',
  '删除这条审计日志？': 'Delete this audit log?',
  '系统': 'System',
}

const englishToChinese = Object.fromEntries(Object.entries(zhToEnglish).map(([zh, en]) => [en, zh]))
const englishFragments = Object.entries(englishToChinese)
  .filter(([english, chinese]) => english.length > 1 && english !== chinese)
  .sort(([left], [right]) => right.length - left.length)

function translateFragments(value: string): string {
  let translated = value
  for (const [english, chinese] of englishFragments) {
    if (translated.includes(english)) translated = translated.split(english).join(chinese)
  }
  return translated
}

export function translateText(value: string, language: Language): string {
  if (language === 'zh') return englishToChinese[value] ?? translateFragments(value)
  return zhToEnglish[value] ?? value
}

function shouldSkipText(element: Element): boolean {
  return Boolean(element.closest('textarea, input, code, pre, .user-message-content > p, .assistant-text, .translated-prompt p, .session-row span'))
}

let scheduled = false
let activeLanguage: Language = 'en'
const textSources = new WeakMap<Text, string>()
const attributeSources = new WeakMap<Element, Map<string, string>>()

function applyTranslations(): void {
  scheduled = false
  const root = document.body
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node as Text
    const parent = text.parentElement
    if (!parent || shouldSkipText(parent)) continue
    const raw = text.nodeValue ?? ''
    const trimmed = raw.trim()
    if (!trimmed) continue
    const source = textSources.get(text) ?? (englishToChinese[trimmed] ?? trimmed)
    textSources.set(text, source)
    const translated = translateText(source, activeLanguage)
    if (translated !== trimmed) {
      const start = raw.indexOf(trimmed)
      text.nodeValue = `${raw.slice(0, start)}${translated}${raw.slice(start + trimmed.length)}`
    }
  }
  for (const element of root.querySelectorAll<HTMLElement>('[title], [aria-label], [placeholder]')) {
    const sources = attributeSources.get(element) ?? new Map<string, string>()
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      const value = element.getAttribute(attribute)
      if (!value) continue
      const source = sources.get(attribute) ?? (englishToChinese[value] ?? value)
      sources.set(attribute, source)
      const translated = translateText(source, activeLanguage)
      if (translated !== value) element.setAttribute(attribute, translated)
    }
    attributeSources.set(element, sources)
  }
}

function scheduleTranslations(): void {
  if (scheduled) return
  scheduled = true
  window.requestAnimationFrame(applyTranslations)
}

let observer: MutationObserver | null = null

export function installLocalization(language: Language): void {
  activeLanguage = language
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  scheduleTranslations()
  observer?.disconnect()
  observer = new MutationObserver(scheduleTranslations)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
}
