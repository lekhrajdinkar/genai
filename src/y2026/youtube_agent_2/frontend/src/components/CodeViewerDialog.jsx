import React from 'react'
import Prism from 'prismjs'
import { LANGUAGE_ALIASES, LANGUAGE_LABELS, escapeHtml } from './CodeBlock'
import { fetchCodeFile, relativeUrl, detectLanguage, resolveSnippetTarget } from './CodeEmbedCard'

export default function CodeViewerDialog({ modal, onClose }) {
  const [copied, setCopied] = React.useState(false)
  const [currentFileIdx, setCurrentFileIdx] = React.useState(modal?.activeFileIdx || 0)
  const [currentTabIdx, setCurrentTabIdx] = React.useState(modal?.activeTabIdx || 0)
  const [activeCode, setActiveCode] = React.useState(modal?.code || '')
  const scrollRef = React.useRef(null)

  const hasParentFiles = Array.isArray(modal?.files) && modal.files.length > 1
  const currentFile = hasParentFiles ? (modal.files[currentFileIdx] || modal.files[0]) : null

  const activeSrc = currentFile ? currentFile.src : (modal?.path || modal?.title)
  const activeFilename = currentFile ? (currentFile.filename || (currentFile.src || '').split('/').at(-1)?.split('?')[0]) : modal?.title
  const activeUrl = currentFile ? relativeUrl(currentFile.src, modal?.noteRawUrl) : modal?.url
  const activeLang = detectLanguage(activeFilename || '') || modal?.language

  // Load code when file changes if different from initial
  React.useEffect(() => {
    if (!hasParentFiles) {
      setActiveCode(modal?.code || '')
      return
    }

    if (currentFileIdx === (modal?.activeFileIdx || 0) && modal?.code) {
      setActiveCode(modal.code)
      return
    }

    if (activeUrl) {
      let cancelled = false
      fetchCodeFile(activeUrl, false)
        .then(txt => {
          if (!cancelled) setActiveCode(txt)
        })
        .catch(() => {
          if (!cancelled) setActiveCode('')
        })
      return () => { cancelled = true }
    }
  }, [hasParentFiles, currentFileIdx, activeUrl, modal])

  const allLines = React.useMemo(() => (activeCode || '').split(/\r?\n/), [activeCode])
  const totalLines = allLines.length

  const tabList = React.useMemo(() => {
    if (hasParentFiles && currentFile) {
      if (Array.isArray(currentFile.tabs) && currentFile.tabs.length > 0) return currentFile.tabs
      if (currentFile.section) return [{ section: currentFile.section, label: currentFile.section }]
      if (currentFile.startLine || currentFile.endLine) {
        return [{
          startLine: currentFile.startLine,
          endLine: currentFile.endLine,
          label: currentFile.startLine && currentFile.endLine ? `Lines ${currentFile.startLine}–${currentFile.endLine}` : 'Snippet'
        }]
      }
      return [{ label: 'Full File' }]
    }
    if (Array.isArray(modal?.tabs) && modal.tabs.length > 0) return modal.tabs
    return []
  }, [hasParentFiles, currentFile, modal])

  const resolvedTabs = React.useMemo(() => {
    return tabList.map(tab => resolveSnippetTarget(tab, allLines))
  }, [tabList, allLines])

  const hasTabs = resolvedTabs.length > 1
  const safeTabIdx = Math.min(currentTabIdx, Math.max(0, resolvedTabs.length - 1))
  const activeTab = hasTabs ? (resolvedTabs[safeTabIdx] || resolvedTabs[0]) : null

  const targetStart = activeTab ? activeTab.startLine : modal?.startLine
  const targetEnd = activeTab ? activeTab.endLine : modal?.endLine

  React.useEffect(() => {
    if (!modal) return undefined
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [modal, onClose])

  React.useEffect(() => {
    if (!modal) return undefined
    if (targetStart && targetStart > 1) {
      const timer = setTimeout(() => {
        const lineEl = document.getElementById(`code-dialog-line-${targetStart}`)
        if (lineEl && scrollRef.current) {
          lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }, 120)
      return () => clearTimeout(timer)
    } else if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [modal, targetStart, currentTabIdx, currentFileIdx])

  if (!modal) return null

  const normalizedLang = LANGUAGE_ALIASES[activeLang?.toLowerCase()] || activeLang?.toLowerCase() || ''
  const displayLabel = LANGUAGE_LABELS[normalizedLang] || (normalizedLang ? normalizedLang.toUpperCase() : 'CODE')

  const highlightedHtml = (() => {
    const raw = String(activeCode ?? '').replace(/\n$/, '')
    const grammar = Prism.languages[normalizedLang]
    if (grammar) {
      try {
        return Prism.highlight(raw, grammar, normalizedLang)
      } catch {
        return escapeHtml(raw)
      }
    }
    return escapeHtml(raw)
  })()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(String(activeCode ?? '').replace(/\n$/, ''))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const githubBlobUrl = (() => {
    if (!activeUrl) return null
    try {
      const parsed = new URL(activeUrl)
      if (parsed.hostname === 'raw.githubusercontent.com') {
        const parts = parsed.pathname.split('/').filter(Boolean)
        if (parts.length >= 3) {
          const owner = parts[0]
          const repo = parts[1]
          const branch = parts[2]
          const rest = parts.slice(3).join('/')
          return `https://github.com/${owner}/${repo}/blob/${branch}/${rest}`
        }
      }
    } catch {}
    return activeUrl
  })()

  return (
    <div
      className="code-dialog-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      role="presentation"
    >
      <section
        className="code-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Source Code: ${activeFilename || 'Code Viewer'}`}
      >
        <header className="code-dialog-header">
          <div className="code-dialog-brand">
            <span className="code-dialog-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
            </span>
            <div className="code-dialog-title-group">
              <div className="code-dialog-title-row">
                <strong title={activeSrc || activeFilename}>{activeFilename}</strong>
                <span className="code-dialog-lang-tag">{displayLabel}</span>
                <span className="code-dialog-lines-tag">{totalLines}L</span>
                {!hasTabs && targetStart && (
                  <span className="code-dialog-jump-tag">
                    L{targetStart}{targetEnd && targetEnd !== targetStart ? `–${targetEnd}` : ''}
                  </span>
                )}
              </div>
              {activeSrc && activeSrc !== activeFilename && <small title={activeSrc}>{activeSrc}</small>}
            </div>
          </div>

          {hasParentFiles && (
            <div className="code-dialog-parent-tabs-bar" role="tablist" aria-label="Source Files">
              {modal.files.map((file, fIdx) => {
                const isActive = fIdx === currentFileIdx
                const fName = file.filename || (file.src || '').split('/').at(-1)?.split('?')[0] || `File ${fIdx + 1}`
                return (
                  <button
                    key={fIdx}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`code-dialog-parent-tab-btn ${isActive ? 'is-active' : ''}`}
                    onClick={() => {
                      setCurrentFileIdx(fIdx)
                      setCurrentTabIdx(0)
                    }}
                    title={file.src}
                  >
                    <span>📄</span>
                    <span>{fName}</span>
                  </button>
                )
              })}
            </div>
          )}

          {hasTabs && (
            <div className="code-dialog-tabs-bar" role="tablist" aria-label="Code Sections">
              {resolvedTabs.map((tab, idx) => {
                const isActive = idx === safeTabIdx
                return (
                  <button
                    key={idx}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`code-dialog-tab-btn ${isActive ? 'is-active' : ''} ${!tab.found ? 'has-error' : ''}`}
                    onClick={() => setCurrentTabIdx(idx)}
                    title={tab.found ? (tab.startLine ? `Lines ${tab.startLine}–${tab.endLine} (${tab.linesCount} lines)` : `${tab.label}`) : tab.error}
                  >
                    <span className="code-dialog-tab-icon">{tab.section ? '§' : '☷'}</span>
                    <span className="code-dialog-tab-label">{tab.label || tab.section}</span>
                    {tab.found && tab.linesCount > 0 && (
                      <span className="code-dialog-tab-count">{tab.linesCount}L</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          <button
            type="button"
            className={`code-dialog-action-icon-btn ${copied ? 'copied' : ''}`}
            onClick={handleCopy}
            aria-label={copied ? 'Copied full file' : 'Copy full file'}
            title={copied ? 'Copied full file!' : 'Copy full file'}
          >
            {copied ? (
              <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <path d="m4 10 4 4 8-8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>

          {githubBlobUrl && (
            <a
              href={githubBlobUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="code-dialog-action-icon-btn"
              title="Open in GitHub ↗"
              aria-label="Open in GitHub ↗"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              </svg>
            </a>
          )}

          <button
            type="button"
            className="code-dialog-close"
            onClick={onClose}
            aria-label="Close code dialog"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div className="code-dialog-stage">
          <div className="code-dialog-scroll" ref={scrollRef}>
            <div className="notes-code-embed-body is-dialog">
              <div className="notes-code-gutter" aria-hidden="true">
                {allLines.map((_, idx) => {
                  const lineNum = idx + 1
                  const isTargetStart = lineNum === targetStart
                  const isInRange = targetStart && targetEnd
                    ? (lineNum >= targetStart && lineNum <= targetEnd)
                    : (targetStart && !targetEnd ? lineNum >= targetStart : false)
                  return (
                    <span
                      id={`code-dialog-line-${lineNum}`}
                      key={idx}
                      className={`${isTargetStart ? 'is-target-start' : ''} ${isInRange ? 'is-range-highlight' : ''}`}
                    >
                      {lineNum}
                    </span>
                  )
                })}
              </div>
              <pre className={`language-${normalizedLang || 'none'}`}>
                <code
                  className={`language-${normalizedLang || 'none'}`}
                  dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                />
              </pre>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
