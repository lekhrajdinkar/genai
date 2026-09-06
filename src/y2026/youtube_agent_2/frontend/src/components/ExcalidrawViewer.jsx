import React from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

/** Parse #json=<fileId>,<key> from a shared Excalidraw URL. */
function parseExcalidrawHash(url) {
  try {
    const hash = new URL(url).hash.replace(/^#/, '')
    const match = hash.match(/^json=([^,]+),(.+)$/)
    return match ? { fileId: match[1], key: match[2] } : null
  } catch {
    return null
  }
}

/**
 * Split binary buffer encoded with Excalidraw's concatBuffers format:
 * [4 bytes version][4 bytes len1][chunk1][4 bytes len2][chunk2]...
 */
function splitConcatBuffers(u8) {
  if (!u8 || u8.byteLength < 8) return null
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const version = dv.getUint32(0)
  if (version !== 1) return null
  let cursor = 4
  const parts = []
  while (cursor < u8.byteLength) {
    if (cursor + 4 > u8.byteLength) break
    const chunkSize = dv.getUint32(cursor)
    cursor += 4
    if (cursor + chunkSize > u8.byteLength) break
    parts.push(u8.slice(cursor, cursor + chunkSize))
    cursor += chunkSize
  }
  return parts
}

/** Import a 128-bit base64url key into a Web Crypto CryptoKey using JWK format. */
async function getCryptoKey(key) {
  return await crypto.subtle.importKey(
    'jwk',
    {
      alg: 'A128GCM',
      ext: true,
      k: key,
      key_ops: ['encrypt', 'decrypt'],
      kty: 'oct',
    },
    {
      name: 'AES-GCM',
      length: 128,
    },
    false,
    ['decrypt']
  )
}

/**
 * Fetch a local/remote .excalidraw file — these are plain JSON, no encryption.
 * The URL is a resolved raw GitHub URL or a local dev-server URL.
 */
async function fetchFileScene(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`File fetch failed (HTTP ${response.status}).`)
  const text = await response.text()
  return JSON.parse(text)
}

/**
 * Fetch and decrypt an excalidraw.com shared scene.
 * Binary format: [outer concatBuffers: metadata, 12-byte IV, ciphertext]
 * Payload format: [deflated/compressed bytes -> inner concatBuffers: metadata, JSON string]
 */
async function fetchScene(fileId, key) {
  const directUrl = `https://json.excalidraw.com/api/v2/${fileId}`
  const proxyUrl = `/excalidraw-api/v2/${fileId}`
  let response
  try {
    response = await fetch(proxyUrl)
    if (!response.ok) response = await fetch(directUrl)
  } catch {
    response = await fetch(directUrl)
  }
  if (!response.ok) throw new Error(`Scene fetch failed (HTTP ${response.status}).`)

  const buffer = await response.arrayBuffer()
  const raw = new Uint8Array(buffer)
  if (raw.length < 13) throw new Error('Scene data too short — may be corrupt or expired.')

  let iv, ciphertext
  const outerParts = splitConcatBuffers(raw)
  if (outerParts && outerParts.length >= 3) {
    iv = outerParts[1]
    ciphertext = outerParts[2]
  } else {
    iv = raw.slice(0, 12)
    ciphertext = raw.slice(12)
  }

  const cryptoKey = await getCryptoKey(key)
  let decrypted
  try {
    decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext)
  } catch (cryptoErr) {
    const detail = cryptoErr?.message || cryptoErr?.name || String(cryptoErr)
    throw new Error(`Decryption failed — the scene may be expired or the key is wrong. (${detail})`)
  }

  const { inflate, inflateRaw } = await import('pako')
  let inflated
  try {
    inflated = inflate(new Uint8Array(decrypted))
  } catch {
    try {
      inflated = inflateRaw(new Uint8Array(decrypted))
    } catch {
      inflated = new Uint8Array(decrypted)
    }
  }

  const innerParts = splitConcatBuffers(inflated)
  let jsonStr
  if (innerParts && innerParts.length >= 2) {
    jsonStr = new TextDecoder().decode(innerParts[1])
  } else {
    jsonStr = new TextDecoder().decode(inflated)
  }

  return JSON.parse(jsonStr)
}

/** Returns true if the URL points to a .excalidraw JSON file (not a shared excalidraw.com link). */
function isExcalidrawFileUrl(url) {
  try { return new URL(url).pathname.toLowerCase().endsWith('.excalidraw') } catch { return false }
}

/**
 * Group active elements logically into animation steps.
 * Containers and their bound text or elements sharing a group are combined into cohesive steps.
 */
function groupElementsIntoSteps(elements = []) {
  const active = elements.filter(el => !el.isDeleted)
  if (!active.length) return []

  const groupMap = new Map()
  active.forEach(el => {
    if (el.groupIds && el.groupIds.length > 0) {
      const rootGroupId = el.groupIds[0]
      if (!groupMap.has(rootGroupId)) groupMap.set(rootGroupId, [])
      groupMap.get(rootGroupId).push(el)
    }
  })

  const processed = new Set()
  const steps = []

  for (let i = 0; i < active.length; i++) {
    const el = active[i]
    if (processed.has(el.id)) continue

    // Group items sharing a group ID together
    if (el.groupIds && el.groupIds.length > 0) {
      const rootGroupId = el.groupIds[0]
      const groupElements = groupMap.get(rootGroupId) || [el]
      const stepItems = []
      groupElements.forEach(item => {
        if (!processed.has(item.id)) {
          stepItems.push(item)
          processed.add(item.id)
        }
      })
      if (stepItems.length) {
        steps.push(stepItems)
      }
      continue
    }

    // Group container with its bound text
    const boundTexts = active.filter(item => item.containerId === el.id)
    const stepItems = [el]
    processed.add(el.id)
    boundTexts.forEach(txt => {
      if (!processed.has(txt.id)) {
        stepItems.push(txt)
        processed.add(txt.id)
      }
    })

    steps.push(stepItems)
  }

  return steps
}

const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    export: false,
    saveAsImage: false,
  },
}

function getAppTheme() {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export default function ExcalidrawViewer({ url, initialTheme, onFallback }) {
  const [status, setStatus] = React.useState('loading')
  const [mode, setMode] = React.useState('') // 'file' | 'shared'
  const [error, setError] = React.useState('')
  const [sceneData, setSceneData] = React.useState(null)
  const [excalidrawAPI, setExcalidrawAPI] = React.useState(null)
  const [theme, setTheme] = React.useState(() => {
    if (initialTheme === 'dark' || initialTheme === 'light') return initialTheme
    return getAppTheme()
  })

  // ── Animation & Playback States ──
  const [isAnimating, setIsAnimating] = React.useState(false)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [currentStep, setCurrentStep] = React.useState(0)
  const [speed, setSpeed] = React.useState(1) // 0.5 | 1 | 1.5 | 2
  const [focusMode, setFocusMode] = React.useState(true) // spotlight mode
  const [autoPan, setAutoPan] = React.useState(false)

  // Sync when initialTheme prop changes
  React.useEffect(() => {
    if (initialTheme === 'dark' || initialTheme === 'light') {
      setTheme(initialTheme)
      if (excalidrawAPI) {
        try {
          excalidrawAPI.updateScene({
            appState: { theme: initialTheme },
            commitToHistory: false,
          })
        } catch {
          // ignore
        }
      }
    }
  }, [initialTheme, excalidrawAPI])

  // Sync theme automatically when app theme (System / Light / Dark) changes
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const observer = new MutationObserver(() => {
      const nextTheme = getAppTheme()
      setTheme(nextTheme)
      if (excalidrawAPI) {
        try {
          excalidrawAPI.updateScene({
            appState: { theme: nextTheme },
            commitToHistory: false,
          })
        } catch {
          // ignore
        }
      }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [excalidrawAPI])

  React.useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setIsAnimating(false)
    setIsPlaying(false)
    setCurrentStep(0)

    const load = async () => {
      try {
        let data
        if (isExcalidrawFileUrl(url)) {
          setMode('file')
          data = await fetchFileScene(url)
        } else {
          setMode('shared')
          const params = parseExcalidrawHash(url)
          if (!params) throw new Error('Invalid Excalidraw share URL — missing scene ID and decryption key.')
          data = await fetchScene(params.fileId, params.key)
        }
        if (!cancelled) {
          setSceneData(data)
          setStatus('ready')
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err?.message || err?.name || String(err) || 'Failed to load Excalidraw drawing.'
          console.error('[ExcalidrawViewer]', err)
          setError(msg)
          setStatus('error')
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [url])

  React.useEffect(() => {
    if (status === 'error' && url) {
      if (onFallback) {
        onFallback()
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    }
  }, [status, url, onFallback])

  const handleToggleTheme = React.useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      if (excalidrawAPI) {
        try {
          excalidrawAPI.updateScene({
            appState: { theme: next },
            commitToHistory: false,
          })
        } catch (err) {
          console.warn('[ExcalidrawViewer] Theme toggle error:', err)
        }
      }
      return next
    })
  }, [excalidrawAPI])

  const sanitizedInitialData = React.useMemo(() => {
    if (!sceneData) return null
    const validElements = Array.isArray(sceneData.elements)
      ? sceneData.elements.filter(el => el && typeof el === 'object')
      : []

    return {
      elements: validElements,
      appState: {
        viewModeEnabled: true,
        zenModeEnabled: false,
        theme: theme,
        viewBackgroundColor: sceneData.appState?.viewBackgroundColor || (theme === 'dark' ? '#121212' : '#ffffff'),
        zoom: { value: 1 },
        scrollX: 0,
        scrollY: 0,
        isLoading: false,
      },
      files: sceneData.files || {},
      scrollToContent: false,
    }
  }, [sceneData, theme])

  const safeScrollToContent = React.useCallback((targetElements, options = { fitToViewport: true, animate: false }) => {
    if (!excalidrawAPI) return
    const elementsToFit = (targetElements && targetElements.length > 0)
      ? targetElements
      : (sceneData?.elements || []).filter(el => el && !el.isDeleted)

    if (!elementsToFit || elementsToFit.length === 0) return

    try {
      const currentZoom = excalidrawAPI.getAppState()?.zoom?.value
      if (typeof currentZoom !== 'number' || isNaN(currentZoom) || currentZoom <= 0) {
        excalidrawAPI.updateScene({
          appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 },
          commitToHistory: false,
        })
      }
      excalidrawAPI.scrollToContent(elementsToFit, options)
    } catch (err) {
      console.warn('[ExcalidrawViewer] safeScrollToContent error:', err)
    }
  }, [excalidrawAPI, sceneData?.elements])

  // Fit to viewport once loaded
  React.useEffect(() => {
    if (!excalidrawAPI || !sceneData?.elements?.length) return
    const timer = setTimeout(() => {
      safeScrollToContent(undefined, { fitToViewport: true, animate: false })
    }, 80)
    return () => clearTimeout(timer)
  }, [excalidrawAPI, sceneData?.elements, safeScrollToContent])

  // Group elements into steps
  const steps = React.useMemo(() => {
    return groupElementsIntoSteps(sceneData?.elements || [])
  }, [sceneData?.elements])

  const totalSteps = steps.length

  // Sync canvas scene with current animation step
  React.useEffect(() => {
    if (!excalidrawAPI || !sceneData?.elements) return

    if (!isAnimating) {
      // Full view: show all elements with their original properties
      excalidrawAPI.updateScene({
        elements: sceneData.elements,
        commitToHistory: false,
      })
      return
    }

    const visibleElements = []
    for (let s = 0; s <= currentStep; s++) {
      const stepEls = steps[s] || []
      const isLatestStep = s === currentStep
      stepEls.forEach(origEl => {
        const opacity = (focusMode && !isLatestStep && totalSteps > 1) ? 35 : (origEl.opacity ?? 100)
        visibleElements.push({
          ...origEl,
          opacity,
        })
      })
    }

    excalidrawAPI.updateScene({
      elements: visibleElements,
      commitToHistory: false,
    })

    if (autoPan && steps[currentStep]?.length) {
      safeScrollToContent(steps[currentStep], { fitToViewport: false, animate: true })
    }
  }, [excalidrawAPI, sceneData, isAnimating, currentStep, focusMode, autoPan, steps, totalSteps, safeScrollToContent])

  // Autoplay timer
  React.useEffect(() => {
    if (!isPlaying || !isAnimating) return
    const intervalMs = Math.max(250, Math.round(950 / speed))
    const timer = setInterval(() => {
      setCurrentStep(prev => {
        if (prev >= totalSteps - 1) {
          setIsPlaying(false)
          return prev
        }
        return prev + 1
      })
    }, intervalMs)
    return () => clearInterval(timer)
  }, [isPlaying, isAnimating, speed, totalSteps])

  // Keyboard navigation
  React.useEffect(() => {
    const handleKeyDown = event => {
      const activeTag = document.activeElement?.tagName?.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return

      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault()
        if (!isAnimating) {
          setIsAnimating(true)
          setCurrentStep(0)
          setIsPlaying(true)
        } else {
          setIsPlaying(p => !p)
        }
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault()
        if (!isAnimating) {
          setIsAnimating(true)
          setCurrentStep(0)
        } else {
          setIsPlaying(false)
          setCurrentStep(p => Math.min(totalSteps - 1, p + 1))
        }
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (isAnimating) {
          setIsPlaying(false)
          setCurrentStep(p => Math.max(0, p - 1))
        }
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        if (!isAnimating) setIsAnimating(true)
        setCurrentStep(0)
        setIsPlaying(true)
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        setFocusMode(f => !f)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isAnimating, totalSteps])

  const toggleAnimateMode = () => {
    if (isAnimating) {
      setIsAnimating(false)
      setIsPlaying(false)
      if (excalidrawAPI && sceneData?.elements) {
        excalidrawAPI.updateScene({ elements: sceneData.elements, commitToHistory: false })
        safeScrollToContent(undefined, { fitToViewport: true, animate: true })
      }
    } else {
      setIsAnimating(true)
      setCurrentStep(0)
      setIsPlaying(true)
    }
  }

  const handleFitAll = () => {
    safeScrollToContent(undefined, { fitToViewport: true, animate: true })
  }

  if (status === 'loading') {
    return (
      <div className="excalidraw-embed-status">
        <span className="spinner" />
        <strong>Loading Excalidraw drawing…</strong>
        <small>{mode === 'file' ? 'Reading scene file.' : 'Fetching and decrypting scene data.'}</small>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="excalidraw-embed-status is-error">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
        <strong>Unable to load Excalidraw drawing</strong>
        <p>{error}</p>
        <small>Opening original drawing in a new tab…</small>
      </div>
    )
  }

  return (
    <div className="excalidraw-viewer-container" data-canvas-theme={theme}>
      {sanitizedInitialData && (
        <Excalidraw
          excalidrawAPI={api => setExcalidrawAPI(api)}
          viewModeEnabled
          theme={theme}
          UIOptions={UI_OPTIONS}
          initialData={sanitizedInitialData}
        />
      )}

      {/* Floating Animation / Presentation Dock */}
      {totalSteps > 1 && (
        <div className={`excalidraw-anim-dock ${isAnimating ? 'is-animating' : ''}`}>
          <div className="excalidraw-anim-dock-main">
            {/* Mode Switcher Button */}
            <button
              type="button"
              className={`excalidraw-anim-toggle-btn ${isAnimating ? 'is-active' : ''}`}
              onClick={toggleAnimateMode}
              title={isAnimating ? 'Exit animation mode (Show full diagram)' : 'Start flow animation (Space)'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {isAnimating ? (
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" fill="none" stroke="currentColor" strokeWidth="2"/>
                ) : (
                  <path d="M5 3l14 9-14 9V3z" fill="currentColor"/>
                )}
              </svg>
              <span>{isAnimating ? 'Full View' : 'Animate Flow'}</span>
            </button>

            {isAnimating && (
              <>
                <div className="excalidraw-anim-dock-divider" aria-hidden="true" />

                {/* Restart */}
                <button
                  type="button"
                  className="excalidraw-anim-btn"
                  onClick={() => { setCurrentStep(0); setIsPlaying(true) }}
                  title="Restart animation from Step 1 (R)"
                  aria-label="Restart from step 1"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
                </button>

                {/* Prev Step */}
                <button
                  type="button"
                  className="excalidraw-anim-btn"
                  disabled={currentStep === 0}
                  onClick={() => { setIsPlaying(false); setCurrentStep(p => Math.max(0, p - 1)) }}
                  title="Previous Step (←)"
                  aria-label="Previous step"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
                </button>

                {/* Play / Pause */}
                <button
                  type="button"
                  className={`excalidraw-anim-btn excalidraw-anim-play-btn ${isPlaying ? 'is-playing' : ''}`}
                  onClick={() => {
                    if (currentStep >= totalSteps - 1 && !isPlaying) {
                      setCurrentStep(0)
                      setIsPlaying(true)
                    } else {
                      setIsPlaying(p => !p)
                    }
                  }}
                  title={isPlaying ? 'Pause (Space)' : 'Play animation (Space)'}
                  aria-label={isPlaying ? 'Pause animation' : 'Play animation'}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    {isPlaying ? (
                      <path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/>
                    ) : (
                      <path d="M6 4l14 8-14 8V4z" fill="currentColor"/>
                    )}
                  </svg>
                </button>

                {/* Next Step */}
                <button
                  type="button"
                  className="excalidraw-anim-btn"
                  disabled={currentStep >= totalSteps - 1}
                  onClick={() => { setIsPlaying(false); setCurrentStep(p => Math.min(totalSteps - 1, p + 1)) }}
                  title="Next Step (→)"
                  aria-label="Next step"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
                </button>

                {/* Scrubber Range Bar */}
                <div className="excalidraw-anim-scrubber-wrap">
                  <input
                    type="range"
                    className="excalidraw-anim-scrubber"
                    min="0"
                    max={totalSteps - 1}
                    value={currentStep}
                    onChange={e => {
                      setIsPlaying(false)
                      setCurrentStep(Number(e.target.value))
                    }}
                    aria-label="Animation progress scrubber"
                  />
                </div>

                {/* Step Counter */}
                <div className="excalidraw-anim-step-badge">
                  <span>{currentStep + 1}</span>
                  <span className="divider">/</span>
                  <span>{totalSteps}</span>
                </div>

                <div className="excalidraw-anim-dock-divider" aria-hidden="true" />

                {/* Speed Selector */}
                <div className="excalidraw-anim-speed-group">
                  {[0.5, 1, 1.5, 2].map(s => (
                    <button
                      key={s}
                      type="button"
                      className={`excalidraw-anim-speed-pill ${speed === s ? 'is-active' : ''}`}
                      onClick={() => setSpeed(s)}
                      title={`Playback Speed: ${s}x`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>

                <div className="excalidraw-anim-dock-divider" aria-hidden="true" />

                {/* Spotlight / Focus Mode */}
                <button
                  type="button"
                  className={`excalidraw-anim-btn ${focusMode ? 'is-active' : ''}`}
                  onClick={() => setFocusMode(f => !f)}
                  title={focusMode ? 'Spotlight Mode: ON (Dims prior elements) [F]' : 'Spotlight Mode: OFF [F]'}
                  aria-label="Toggle spotlight mode"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2"/>
                    <circle cx="12" cy="12" r="4" fill="currentColor"/>
                  </svg>
                </button>

                {/* Auto Pan Camera */}
                <button
                  type="button"
                  className={`excalidraw-anim-btn ${autoPan ? 'is-active' : ''}`}
                  onClick={() => setAutoPan(p => !p)}
                  title={autoPan ? 'Camera Follow: ON (Auto-pans to new elements)' : 'Camera Follow: OFF'}
                  aria-label="Toggle camera follow"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M23 7l-7 5 7 5V7z" fill="currentColor"/>
                    <rect x="1" y="5" width="15" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2"/>
                  </svg>
                </button>
              </>
            )}

            {/* Quick Theme Toggle */}
            <button
              type="button"
              className="excalidraw-anim-btn"
              onClick={handleToggleTheme}
              title={theme === 'dark' ? 'Switch drawing to Light theme (Shift+Alt+D)' : 'Switch drawing to Dark theme (Shift+Alt+D)'}
              aria-label={theme === 'dark' ? 'Switch drawing to Light theme' : 'Switch drawing to Dark theme'}
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
            </button>

            {/* Fit Viewport Button */}
            <button
              type="button"
              className="excalidraw-anim-btn"
              onClick={handleFitAll}
              title="Fit diagram to viewport"
              aria-label="Fit diagram to viewport"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
