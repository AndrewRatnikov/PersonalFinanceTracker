// Auto-lock after inactivity (spec §2.4). Time spent in a hidden tab counts as
// inactive even when the browser throttles timers: on becoming visible the
// elapsed time is checked against the timeout directly.

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown'] as const

export function startAutoLock(
  minutes: number,
  onLock: () => void,
  doc: Document = document,
): () => void {
  if (!(minutes > 0)) return () => {}

  const timeoutMs = minutes * 60_000
  let lastActivity = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const type of ACTIVITY_EVENTS) {
      doc.removeEventListener(type, onActivity)
    }
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }

  const lock = () => {
    stop()
    onLock()
  }

  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    const remaining = lastActivity + timeoutMs - Date.now()
    timer = setTimeout(onTimer, Math.max(0, remaining))
  }

  function onTimer() {
    timer = null
    if (stopped) return
    if (Date.now() - lastActivity >= timeoutMs) lock()
    else schedule()
  }

  function onActivity() {
    lastActivity = Date.now()
  }

  function onVisibilityChange() {
    if (doc.visibilityState !== 'visible') return
    if (Date.now() - lastActivity >= timeoutMs) {
      lock()
      return
    }
    lastActivity = Date.now()
    schedule()
  }

  for (const type of ACTIVITY_EVENTS) {
    doc.addEventListener(type, onActivity)
  }
  doc.addEventListener('visibilitychange', onVisibilityChange)
  schedule()

  return stop
}
