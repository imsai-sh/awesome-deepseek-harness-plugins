import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Fish, Gamepad2 } from 'lucide-react'
import { useI18n } from '../lib/i18n'

// 看板娘（桌宠）：右下角悬浮的 DeepSeek 鲸鱼娘。
// 角色素材来自 whale-girl（https://github.com/vlln/whale-girl，MIT）：
//   角色「鲸鱼娘」by ZipZipPipe，15 状态精灵图契约（帧横排 256×256、帧0=常态起点），
//   本页用到 idle/joy/eat/play/welcome/drag/think/sleep/wake/walk 十个状态，
//   许可文本随资源存放于 /pet/whale-girl/LICENSE。
// 所有偏好都存在 localStorage 里，读写都是非致命的（沙箱 iframe / 隐私模式可能抛错）。

const STORAGE_POS = 'dsh-1024store-pet-pos'
const STORAGE_FEEDS = 'dsh-1024store-pet-feeds'
const STORAGE_GREETED = 'dsh-1024store-pet-greeted'

/** 拖动超过该像素数才视为拖拽（而不是点击）。 */
const DRAG_THRESHOLD = 6
/** 气泡自动消失时间。 */
const SPEECH_DURATION_MS = 4500
/** 空闲多久后入睡。 */
const SLEEP_AFTER_MS = 60_000
/** 周期游走：随机间隔 / 速度 / 单次距离范围 / 视口边距。 */
const WALK_AFTER_MIN = 25_000
const WALK_AFTER_MAX = 45_000
const WALK_SPEED = 70
const WALK_DISTANCE_MIN = 60
const WALK_DISTANCE_MAX = 200
const WALK_MARGIN = 12
/** 3D 倾斜最大角度（pointer 跟随）。 */
const TILT_MAX_DEG = 10
/** 静态资源根。 */
const SHEET_BASE = '/pet/whale-girl/'

/** 用到的状态子集（帧数/fps/播放行为与 whale-girl manifest 一致）。 */
const PET_STATE_KEYS = ['idle', 'joy', 'eat', 'play', 'welcome', 'drag', 'think', 'sleep', 'wake', 'walk'] as const
type PetState = (typeof PET_STATE_KEYS)[number]

interface PetStateMeta {
  sheet: string
  frames: number
  fps: number
  playback: 'blink' | 'loop' | 'once' | 'pingpong'
  motion?: 'tilt' | 'float'
}

const PET_STATES: Record<PetState, PetStateMeta> = {
  idle: { sheet: 'idle.png', frames: 3, fps: 2, playback: 'blink' },
  joy: { sheet: 'joy.png', frames: 2, fps: 5, playback: 'loop' },
  eat: { sheet: 'eat.png', frames: 3, fps: 8, playback: 'loop' },
  play: { sheet: 'play.png', frames: 3, fps: 4, playback: 'loop' },
  welcome: { sheet: 'welcome.png', frames: 2, fps: 3, playback: 'loop' },
  drag: { sheet: 'drag.png', frames: 1, fps: 5, playback: 'loop', motion: 'tilt' },
  think: { sheet: 'think.png', frames: 1, fps: 2, playback: 'loop', motion: 'float' },
  sleep: { sheet: 'sleep.png', frames: 2, fps: 1, playback: 'loop' },
  wake: { sheet: 'wake.png', frames: 2, fps: 3, playback: 'once' },
  walk: { sheet: 'walk.png', frames: 3, fps: 6, playback: 'pingpong' },
}

const LINES = {
  zh: [
    '嘿嘿，欢迎常来逛插件市场～',
    '今天也要元气满满哦！',
    '右上角搜一搜，可能有惊喜～',
    '我每天都在这里等你呢。',
    '装个桌宠插件陪陪我嘛？',
  ],
  en: [
    'Hehe, happy browsing!',
    'Stay energized today!',
    'Try searching — you might find a gem!',
    "I'll be right here, every day.",
    'Want a desktop pet plugin to keep me company?',
  ],
} as const

const FEED_LINES = {
  zh: ['谢谢投喂小鱼干！', '小鱼干真好吃～', '吃饱了继续帮你看店！'],
  en: ['Thanks for the fish!', 'Yum, dried fish!', 'Fully charged now!'],
} as const

const PLAY_LINES = {
  zh: ['来玩抛接球！', '接住啦，再高点！', '和你玩真开心～'],
  en: ['Let us play catch!', 'Got it — higher!', 'Playing with you is fun!'],
} as const

const MILESTONE_LINES = {
  zh: (count: number) => `第 ${count} 条小鱼干啦，最爱你了！`,
  en: (count: number) => `${count} fish already — I love you the most!`,
} as const

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function persistStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The preference still applies for the current session.
  }
}

function readPosition(): { x: number; y: number } | null {
  const raw = readStorage(STORAGE_POS)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return { x: parsed.x, y: parsed.y }
    }
  } catch {
    // Corrupt value; fall back to the default corner.
  }
  return null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function randomOf(items: readonly string[]) {
  return items[Math.floor(Math.random() * items.length)]
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 单帧精灵（百分比背景尺寸：整帧等比缩放进容器，帧内内容不会被裁切）。 */
function PetSprite({ state, frame, layer }: { state: PetState; frame: number; layer?: 'depth' }) {
  const meta = PET_STATES[state]
  const motionClass = layer === 'depth' ? '' : meta.motion !== undefined ? ` is-${meta.motion}` : ''
  const layerClass = layer === 'depth' ? ' kanban-girl-depth' : ''
  return (
    <div
      className={`kanban-girl-sprite${motionClass}${layerClass}`}
      style={{
        backgroundImage: `url(${SHEET_BASE}${meta.sheet})`,
        // frames 帧横排：宽 = frames × 容器宽，帧 i 偏移 i/(frames-1)（百分比定位）
        backgroundSize: `${meta.frames * 100}% 100%`,
        backgroundPosition: `${meta.frames > 1 ? (frame / (meta.frames - 1)) * 100 : 0}% 0`,
      }}
    />
  )
}

export function KanbanGirl() {
  const { language, t } = useI18n()

  const [pos, setPos] = useState<{ x: number; y: number } | null>(readPosition)
  const [feedCount, setFeedCount] = useState(() => {
    const raw = readStorage(STORAGE_FEEDS)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  })
  const [speech, setSpeech] = useState<{ id: number; text: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hearts, setHearts] = useState<{ id: number; x: number }[]>([])
  const [state, setState] = useState<PetState>('idle')
  const [frame, setFrame] = useState(0)
  /** 朝向：1 = 朝左（素材默认），-1 = 镜像朝右。 */
  const [flip, setFlip] = useState<1 | -1>(1)

  const rootRef = useRef<HTMLDivElement>(null)
  const petRef = useRef<HTMLButtonElement>(null)
  const speechTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    baseX: number
    baseY: number
    moved: boolean
  } | null>(null)
  const didDragRef = useRef(false)
  const stateRef = useRef<PetState>('idle')
  stateRef.current = state
  /** 状态序列（eat→joy→idle 之类）的计时器，切换状态时整体清掉。 */
  const transitionTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ambientTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reduceMotion = useRef(prefersReducedMotion()).current
  /** 周期游走状态：rAF 推进横向位移。 */
  const walkRef = useRef<{
    from: number
    target: number
    y: number
    distance: number
    dir: 1 | -1
    progress: number
    last: number
  } | null>(null)
  const walkRaf = useRef<number | undefined>(undefined)

  const say = (text: string) => {
    if (speechTimer.current !== undefined) clearTimeout(speechTimer.current)
    setSpeech({ id: Date.now(), text })
    speechTimer.current = setTimeout(() => setSpeech(null), SPEECH_DURATION_MS)
  }

  /** 播放一段状态序列，然后回到 final；重复调用会取消上一次未播完的序列。 */
  const playSequence = (steps: ReadonlyArray<readonly [PetState, number]>, final: PetState = 'idle') => {
    for (const timer of transitionTimers.current) clearTimeout(timer)
    transitionTimers.current = []
    let delay = 0
    for (const [next, ms] of steps) {
      transitionTimers.current.push(setTimeout(() => setState(next), delay))
      delay += ms
    }
    transitionTimers.current.push(setTimeout(() => setState(final), delay))
  }

  /** 重置「空闲入睡」计时：任何互动后重新计时。 */
  const resetSleep = () => {
    if (sleepTimer.current !== undefined) clearTimeout(sleepTimer.current)
    sleepTimer.current = setTimeout(() => {
      setState((current) => (current === 'idle' || current === 'think' ? 'sleep' : current))
    }, SLEEP_AFTER_MS)
  }

  // ── 周期游走 ────────────────────────────────────────────────────────────
  const persistPosition = (x: number, y: number) => {
    setPos({ x, y })
    try {
      window.localStorage.setItem(STORAGE_POS, JSON.stringify({ x, y }))
    } catch {
      // Position still applies for the current session.
    }
  }

  const stopWalking = () => {
    if (walkRaf.current !== undefined) cancelAnimationFrame(walkRaf.current)
    walkRaf.current = undefined
    walkRef.current = null
  }

  const walkTick = (now: number) => {
    const walk = walkRef.current
    if (!walk) return
    const dt = Math.min(50, now - walk.last)
    walk.last = now
    walk.progress += (WALK_SPEED * dt) / 1000
    if (walk.progress >= walk.distance) {
      stopWalking()
      setState('idle')
      persistPosition(walk.target, walk.y)
      return
    }
    const x = walk.dir === 1 ? walk.from - walk.progress : walk.from + walk.progress
    setPos({ x, y: walk.y })
    walkRaf.current = requestAnimationFrame(walkTick)
  }

  const startWalk = () => {
    const pet = petRef.current
    if (!pet || dragRef.current !== null || walkRef.current !== null) return
    const rect = pet.getBoundingClientRect()
    const size = rect.width
    const startX = rect.left
    const y = rect.top
    const maxX = Math.max(WALK_MARGIN, window.innerWidth - size - WALK_MARGIN)
    const spaceOf = (d: 1 | -1) => (d === 1 ? startX - WALK_MARGIN : maxX - startX)
    // 随机方向；该方向空间不足（贴近视口边缘）时换另一方向
    let dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1
    let space = spaceOf(dir)
    if (space < 16) {
      dir = dir === 1 ? -1 : 1
      space = spaceOf(dir)
      if (space < 16) return // 两侧都没有空间
    }
    const distance = Math.max(
      0,
      Math.min(WALK_DISTANCE_MIN + Math.random() * (WALK_DISTANCE_MAX - WALK_DISTANCE_MIN), space),
    )
    const target = dir === 1 ? startX - distance : startX + distance
    setPos({ x: startX, y })
    setFlip(dir === 1 ? 1 : -1)
    setState('walk')
    walkRef.current = { from: startX, target, y, distance, dir, progress: 0, last: performance.now() }
    walkRaf.current = requestAnimationFrame(walkTick)
  }

  // ── 3D 倾斜（pointer 跟随，perspective 见 CSS）──────────────────────────
  const applyTilt = (clientX: number, clientY: number) => {
    if (reduceMotion) return
    const pet = petRef.current
    if (!pet) return
    const rect = pet.getBoundingClientRect()
    const px = (clientX - rect.left) / rect.width - 0.5
    const py = (clientY - rect.top) / rect.height - 0.5
    pet.style.setProperty('--kanban-tilt-x', `${(-py * 2 * TILT_MAX_DEG).toFixed(2)}deg`)
    pet.style.setProperty('--kanban-tilt-y', `${(px * 2 * TILT_MAX_DEG).toFixed(2)}deg`)
  }

  const resetTilt = () => {
    const pet = petRef.current
    if (!pet) return
    pet.style.setProperty('--kanban-tilt-x', '0deg')
    pet.style.setProperty('--kanban-tilt-y', '0deg')
  }

  // 帧播放器：按 manifest 的 playback 语义推进帧（blink=常态帧0+随机眨眼）。
  useEffect(() => {
    const meta = PET_STATES[state]
    const timers: ReturnType<typeof setTimeout>[] = []
    setFrame(0)
    if (reduceMotion) return () => {}
    const stepMs = Math.round(1000 / meta.fps)
    const push = (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      timers.push(timer)
      return timer
    }
    if (meta.playback === 'blink') {
      const schedule = () => push(() => {
        push(() => setFrame(1), stepMs)
        push(() => setFrame(2), stepMs * 2)
        push(() => {
          setFrame(0)
          schedule()
        }, stepMs * 3)
      }, 2200 + Math.random() * 3800)
      schedule()
    } else if (meta.playback === 'once') {
      let index = 0
      const step = () => {
        setFrame(index)
        index += 1
        if (index < meta.frames) push(step, stepMs)
      }
      step()
    } else if (meta.playback === 'pingpong') {
      // 往返 0→1→…→N-1→…→0（walk 步态）
      let index = 0
      let direction = 1
      const tick = () => {
        setFrame(index)
        index += direction
        if (index >= meta.frames) {
          index = meta.frames - 2
          direction = -1
        } else if (index < 0) {
          index = 1
          direction = 1
        }
        push(tick, stepMs)
      }
      push(tick, stepMs)
    } else {
      const tick = () => {
        setFrame((current) => (current + 1) % meta.frames)
        push(tick, stepMs)
      }
      push(tick, stepMs)
    }
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [state, reduceMotion])

  // 首次访问打个招呼（只一次）。
  useEffect(() => {
    if (readStorage(STORAGE_GREETED) !== null) return
    persistStorage(STORAGE_GREETED, '1')
    const timer = setTimeout(() => {
      say(t('petGreeting'))
      playSequence([['welcome', 2600]])
    }, 800)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 预加载精灵图，保证互动即时反馈。
  useEffect(() => {
    const images = Object.values(PET_STATES).map((meta) => {
      const image = new Image()
      image.src = `${SHEET_BASE}${meta.sheet}`
      return image
    })
    return () => {
      for (const image of images) image.src = ''
    }
  }, [])

  // 空闲计时 + 随机陪伴（think）插曲 + 周期游走。
  useEffect(() => {
    resetSleep()
    if (reduceMotion) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const scheduleAmbient = () => {
      const timer = setTimeout(() => {
        if (stateRef.current === 'idle') playSequence([['think', 2600]])
        scheduleAmbient()
      }, 15_000 + Math.random() * 20_000)
      timers.push(timer)
    }
    const scheduleWalk = () => {
      const timer = setTimeout(() => {
        if (stateRef.current === 'idle' || stateRef.current === 'think') startWalk()
        scheduleWalk()
      }, WALK_AFTER_MIN + Math.random() * (WALK_AFTER_MAX - WALK_AFTER_MIN))
      timers.push(timer)
    }
    scheduleAmbient()
    scheduleWalk()
    return () => {
      for (const timer of timers) clearTimeout(timer)
      if (sleepTimer.current !== undefined) clearTimeout(sleepTimer.current)
      if (ambientTimer.current !== undefined) clearTimeout(ambientTimer.current)
      stopWalking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (speechTimer.current !== undefined) clearTimeout(speechTimer.current)
      for (const timer of transitionTimers.current) clearTimeout(timer)
      if (sleepTimer.current !== undefined) clearTimeout(sleepTimer.current)
      if (ambientTimer.current !== undefined) clearTimeout(ambientTimer.current)
      stopWalking()
    }
  }, [])

  // 菜单打开时：点击别处或按 Esc 关闭。
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const spawnHeart = () => {
    const id = Date.now() + Math.random()
    const x = Math.round(Math.random() * 28 - 14)
    setHearts((current) => [...current.slice(-4), { id, x }])
    setTimeout(() => {
      setHearts((current) => current.filter((heart) => heart.id !== id))
    }, 1300)
  }

  const interact = () => {
    if (didDragRef.current) {
      didDragRef.current = false
      return
    }
    stopWalking()
    setMenuOpen((open) => !open)
    say(randomOf(LINES[language]))
    resetSleep()
    if (stateRef.current === 'sleep') playSequence([['wake', 1200], ['joy', 1200]])
    else playSequence([['joy', 1500]])
  }

  const feed = () => {
    const next = feedCount + 1
    setFeedCount(next)
    persistStorage(STORAGE_FEEDS, String(next))
    spawnHeart()
    resetSleep()
    stopWalking()
    if (next > 0 && next % 5 === 0) say(MILESTONE_LINES[language](next))
    else say(randomOf(FEED_LINES[language]))
    playSequence([['eat', 1300], ['joy', 1300]])
  }

  const play = () => {
    spawnHeart()
    resetSleep()
    stopWalking()
    say(randomOf(PLAY_LINES[language]))
    playSequence([['play', 1700], ['joy', 1100]])
  }

  // ── 拖拽 ────────────────────────────────────────────────────────────────
  const petPositionOf = (drag: NonNullable<typeof dragRef.current>, clientX: number, clientY: number) => {
    const size = petRef.current?.getBoundingClientRect().width ?? 0
    const x = clamp(drag.baseX + (clientX - drag.startX), 0, Math.max(0, window.innerWidth - size))
    const y = clamp(drag.baseY + (clientY - drag.startY), 0, Math.max(0, window.innerHeight - size))
    return { x, y }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pet = petRef.current
    if (!pet) return
    const rect = pet.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: rect.left,
      baseY: rect.top,
      moved: false,
    }
    try {
      pet.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture can fail for synthetic events; drag still works.
    }
    pet.classList.add('is-dragging')
    // 互动即唤醒（睡梦中点一下先伸懒腰）
    if (stateRef.current === 'sleep') playSequence([['wake', 1200]])
    resetSleep()
    stopWalking()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag && event.pointerId === drag.pointerId) {
      if (
        !drag.moved
        && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD
      ) {
        return
      }
      drag.moved = true
      for (const timer of transitionTimers.current) clearTimeout(timer)
      transitionTimers.current = []
      setState('drag')
      setPos(petPositionOf(drag, event.clientX, event.clientY))
    }
    applyTilt(event.clientX, event.clientY)
  }

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    const pet = petRef.current
    if (pet) {
      pet.classList.remove('is-dragging')
      try {
        pet.releasePointerCapture(event.pointerId)
      } catch {
        // Capture may already be released.
      }
    }
    didDragRef.current = drag.moved
    if (drag.moved) {
      // 让紧随其后的 click 事件被吞掉一次（拖拽结束不应触发点击），随后复位。
      setTimeout(() => {
        didDragRef.current = false
      }, 0)
      const next = petPositionOf(drag, event.clientX, event.clientY)
      setPos(next)
      setState('idle')
      resetTilt()
      try {
        window.localStorage.setItem(STORAGE_POS, JSON.stringify(next))
      } catch {
        // Position still applies for the current session.
      }
    }
  }

  const rootStyle: CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { right: 16, bottom: 16 }

  return (
    <div ref={rootRef} className="kanban-girl-root" style={rootStyle}>
      <div className="kanban-girl-pop">
        {speech !== null && (
          <p key={speech.id} className="kanban-girl-bubble" role="status">
            {speech.text}
          </p>
        )}
        {menuOpen && (
          <div className="kanban-girl-menu">
            <button
              type="button"
              className="kanban-girl-action"
              aria-label={t('petFeed')}
              title={t('petFeed')}
              onClick={feed}
            >
              <Fish size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="kanban-girl-action"
              aria-label={t('petPlay')}
              title={t('petPlay')}
              onClick={play}
            >
              <Gamepad2 size={18} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <button
        ref={petRef}
        type="button"
        className="kanban-girl"
        aria-label={t('petLabel')}
        onClick={interact}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={resetTilt}
      >
        <span className="kanban-girl-flip" style={{ transform: `scaleX(${flip})` }}>
          <span className="kanban-girl-3d">
            {/* 背面厚度层：translateZ 下沉 + 模糊压暗，摆动时从主体边缘露出形成立体厚度 */}
            <PetSprite state={state} frame={frame} layer="depth" />
            <PetSprite state={state} frame={frame} />
            <span className="kanban-girl-shine" aria-hidden="true" />
          </span>
        </span>
      </button>
      <div className="kanban-girl-shadow" aria-hidden="true" />

      <span className="kanban-girl-bubble-dot" aria-hidden="true" />
      <span className="kanban-girl-bubble-dot" aria-hidden="true" />
      <span className="kanban-girl-bubble-dot" aria-hidden="true" />

      {hearts.map((heart) => (
        <span
          key={heart.id}
          className="kanban-girl-heart"
          style={{ left: `calc(50% + ${heart.x}px)` }}
          aria-hidden="true"
        >
          ♥
        </span>
      ))}
    </div>
  )
}
