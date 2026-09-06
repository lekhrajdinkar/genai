import React from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

const excalidrawCache = new Map()

/** Helper to fetch and parse local/remote .excalidraw JSON with caching */
async function fetchExcalidrawJson(url) {
  if (excalidrawCache.has(url)) return excalidrawCache.get(url)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json()
  excalidrawCache.set(url, data)
  return data
}

const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    export: false,
    saveAsImage: false,
    clearCanvas: false,
  },
}

function getAppTheme() {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function ExcalidrawThumbnail({ url, descriptor, label, onOpen }) {
  const [sceneData, setSceneData] = React.useState(() => excalidrawCache.get(url) || null)
  const [loading, setLoading] = React.useState(() => !excalidrawCache.has(url))
  const [error, setError] = React.useState(false)
  const [excalidrawAPI, setExcalidrawAPI] = React.useState(null)
  const [zoomPercent, setZoomPercent] = React.useState(100)
  const [theme, setTheme] = React.useState(() => getAppTheme())

  const title = label || descriptor?.title || (url ? url.split('/').at(-1) : 'Excalidraw Drawing')
  const fileName = url ? decodeURIComponent(url.split('/').at(-1) || '') : ''

  // Sync theme automatically when the app theme (System / Light / Dark) changes
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
    if (excalidrawCache.has(url)) {
      setSceneData(excalidrawCache.get(url))
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(false)

    fetchExcalidrawJson(url)
      .then(data => {
        if (!cancelled) {
          setSceneData(data)
          setLoading(false)
        }
      })
      .catch(err => {
        console.warn('[ExcalidrawThumbnail] Failed to load JSON:', err)
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [url])

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
      console.warn('[ExcalidrawThumbnail] safeScrollToContent error:', err)
    }
  }, [excalidrawAPI, sceneData?.elements])

  // Automatically fit drawing to viewport on initial load
  React.useEffect(() => {
    if (!excalidrawAPI || !sceneData?.elements?.length) return
    const timer = setTimeout(() => {
      safeScrollToContent(undefined, { fitToViewport: true, animate: false })
      const currentZoom = excalidrawAPI.getAppState()?.zoom?.value
      const safeZ = (typeof currentZoom === 'number' && !isNaN(currentZoom) && currentZoom > 0) ? currentZoom : 1
      setZoomPercent(Math.round(safeZ * 100))
    }, 80)
    return () => clearTimeout(timer)
  }, [excalidrawAPI, sceneData?.elements, safeScrollToContent])

  // Track zoom level changes from wheel/trackpad/drag
  const handlePointerUpdate = React.useCallback(() => {
    if (excalidrawAPI) {
      const currentZoom = excalidrawAPI.getAppState()?.zoom?.value
      const safeZ = (typeof currentZoom === 'number' && !isNaN(currentZoom) && currentZoom > 0) ? currentZoom : 1
      setZoomPercent(Math.round(safeZ * 100))
    }
  }, [excalidrawAPI])

  const handleZoom = React.useCallback(delta => {
    if (!excalidrawAPI) return
    const currentZoom = excalidrawAPI.getAppState()?.zoom?.value
    const safeZ = (typeof currentZoom === 'number' && !isNaN(currentZoom) && currentZoom > 0) ? currentZoom : 1
    const nextZoom = Math.min(5, Math.max(0.1, Number((safeZ + delta).toFixed(2))))
    excalidrawAPI.updateScene({
      appState: { zoom: { value: nextZoom } },
      commitToHistory: false,
    })
    setZoomPercent(Math.round(nextZoom * 100))
  }, [excalidrawAPI])

  const handleResetZoom = React.useCallback(() => {
    if (!excalidrawAPI) return
    excalidrawAPI.updateScene({
      appState: { zoom: { value: 1 } },
      commitToHistory: false,
    })
    setZoomPercent(100)
  }, [excalidrawAPI])

  const handleFit = React.useCallback(() => {
    if (!excalidrawAPI) return
    safeScrollToContent(undefined, { fitToViewport: true, animate: true })
    setTimeout(() => {
      if (excalidrawAPI) {
        const currentZoom = excalidrawAPI.getAppState()?.zoom?.value
        const safeZ = (typeof currentZoom === 'number' && !isNaN(currentZoom) && currentZoom > 0) ? currentZoom : 1
        setZoomPercent(Math.round(safeZ * 100))
      }
    }, 150)
  }, [excalidrawAPI, safeScrollToContent])

  const handleToggleTheme = React.useCallback((e) => {
    e?.stopPropagation?.()
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      if (excalidrawAPI) {
        try {
          excalidrawAPI.updateScene({
            appState: { theme: next },
            commitToHistory: false,
          })
        } catch (err) {
          console.warn('[ExcalidrawThumbnail] Theme toggle error:', err)
        }
      }
      return next
    })
  }, [excalidrawAPI])

  const initialData = React.useMemo(() => {
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

  const elementCount = (sceneData?.elements || []).filter(el => !el.isDeleted).length

  if (error || (!loading && !sceneData)) {
    return (
      <a
        href={url}
        className="notes-excalidraw-fallback-link"
        onClick={event => { event.preventDefault(); onOpen?.(descriptor) }}
        title={`Open ${title}`}
      >
        <span className="notes-rich-link-icon">🎨</span>
        <span>{title}</span>
        <small className="notes-excalidraw-ext">.excalidraw</small>
      </a>
    )
  }

  return (
    <div
      className="notes-excalidraw-thumbnail-card"
      data-canvas-theme={theme}
      aria-label={`Excalidraw drawing: ${title}`}
    >
      <div className="notes-excalidraw-thumbnail-header">
        <div className="notes-excalidraw-thumbnail-title-group">
          <span className="notes-excalidraw-logo-badge" aria-hidden="true">
            <svg viewBox="0 0 48 48">
              <rect x="3" y="12" width="32" height="23" rx="4" fill="currentColor" opacity="0.15"/>
              <rect x="3" y="12" width="32" height="23" rx="4" stroke="currentColor" strokeWidth="2.5" fill="none"/>
              <path d="M8 28l5-10 5 6 5-8 5 12" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M36 4l8 8-12 12-5 1 1-5z" fill="currentColor"/>
            </svg>
          </span>
          <strong className="notes-excalidraw-thumbnail-title" title={title}>{title}</strong>
        </div>

        <div className="notes-excalidraw-thumbnail-meta">
          <div className="notes-excalidraw-zoom-toolbar" role="toolbar" aria-label="Drawing zoom controls">
            <button
              type="button"
              className="notes-excalidraw-zoom-btn"
              onClick={() => handleZoom(-0.25)}
              title="Zoom out"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="notes-excalidraw-zoom-btn notes-excalidraw-zoom-value"
              onClick={handleResetZoom}
              title="Reset zoom to 100%"
              aria-label="Reset zoom to 100%"
            >
              {zoomPercent}%
            </button>
            <button
              type="button"
              className="notes-excalidraw-zoom-btn"
              onClick={() => handleZoom(0.25)}
              title="Zoom in"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="notes-excalidraw-zoom-btn notes-excalidraw-fit-btn"
              onClick={handleFit}
              title="Fit diagram to viewport"
              aria-label="Fit diagram to viewport"
            >
              Fit
            </button>
          </div>

          {/* Quick Theme Toggle on Thumbnail */}
          <button
            type="button"
            className={`notes-excalidraw-theme-toggle-btn ${theme === 'dark' ? 'is-dark' : 'is-light'}`}
            onClick={handleToggleTheme}
            title={theme === 'dark' ? 'Switch drawing to Light theme (Shift+Alt+D)' : 'Switch drawing to Dark theme (Shift+Alt+D)'}
            aria-label={theme === 'dark' ? 'Switch drawing to Light theme' : 'Switch drawing to Dark theme'}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>

          <button
            type="button"
            className="notes-excalidraw-expand-icon-btn"
            onClick={() => onOpen?.(descriptor)}
            title="Open in full reader"
            aria-label="Open in full reader"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="notes-excalidraw-thumbnail-stage" data-canvas-theme={theme}>
        {loading || !initialData ? (
          <div className="notes-excalidraw-thumbnail-loading">
            <span className="spinner" />
            <span>Loading interactive drawing…</span>
          </div>
        ) : (
          <div className="notes-excalidraw-thumbnail-canvas-container">
            <Excalidraw
              excalidrawAPI={setExcalidrawAPI}
              onPointerUpdate={handlePointerUpdate}
              viewModeEnabled
              zenModeEnabled
              theme={theme}
              UIOptions={UI_OPTIONS}
              initialData={initialData}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default React.memo(ExcalidrawThumbnail)
