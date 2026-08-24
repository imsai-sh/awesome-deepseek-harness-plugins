import { AlertTriangle, Check, LoaderCircle, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useEmbedBridge } from '../lib/embedBridge'
import { useI18n } from '../lib/i18n'

/**
 * Uninstall trigger for the installed-plugins tab of the embedded store.
 *
 * Uninstalling is destructive — it removes the plugin and its dependencies
 * from the profile — so the first click opens an in-app confirmation dialog
 * instead of acting immediately. The dialog is deliberately not a native
 * `window.confirm`: the host shell used to suppress that and freeze the whole
 * flow. A failed attempt retries directly (the reader already confirmed once);
 * the install console shows the executed command and its output while the
 * uninstall runs, same as installs. The store's own package cannot be
 * uninstalled here — the local endpoint refuses it — so its row keeps the
 * disabled installed state instead of a live trigger.
 */
export function BridgeUninstallButton({
  pluginId,
  pluginName,
  className = 'split-install-main bridge-uninstall',
}: {
  pluginId: string
  /** Display name shown in the confirmation dialog. */
  pluginName?: string
  className?: string
}) {
  const { uninstall } = useEmbedBridge()
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'removing' | 'removed' | 'failed'>('idle')
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Focus the destructive action when the dialog opens and let Escape close it.
  useEffect(() => {
    if (!confirming) return
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirming(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [confirming])

  async function runUninstall() {
    setConfirming(false)
    setState('removing')
    setError('')
    try {
      const result = await uninstall(pluginId)
      if (!result.ok) throw new Error(result.error || t('bridgeUninstallFailed'))
      setState('removed')
    } catch (uninstallError) {
      setError(uninstallError instanceof Error ? uninstallError.message : String(uninstallError))
      setState('failed')
    }
  }

  const label = state === 'removing'
    ? t('bridgeUninstalling')
    : state === 'removed'
      ? t('bridgeUninstalled')
      : state === 'failed'
        ? t('retry')
        : t('bridgeUninstall')
  const Icon = state === 'removing' ? LoaderCircle : state === 'removed' ? Check : Trash2

  return (
    <>
      <button
        type="button"
        className={`${className}${state === 'removing' ? ' is-busy' : ''}`}
        data-state={state}
        onClick={() => {
          // A retry needs no second confirmation — the reader already accepted
          // the removal; only an idle click opens the dialog.
          if (state === 'failed') void runUninstall()
          else setConfirming(true)
        }}
        disabled={state === 'removing' || state === 'removed'}
        aria-label={label}
        title={error || label}
      >
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
      </button>

      {confirming && (
        <div
          className="bridge-confirm-backdrop"
          onClick={() => setConfirming(false)}
        >
          <div
            className="bridge-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bridge-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="bridge-confirm-head">
              <AlertTriangle size={18} aria-hidden="true" />
              <h3 id="bridge-confirm-title">{t('confirmUninstallTitle')}</h3>
              <button
                type="button"
                className="bridge-confirm-close"
                aria-label={t('confirmUninstallCancel')}
                onClick={() => setConfirming(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <p className="bridge-confirm-body">
              {t('confirmUninstallBody', { name: pluginName ?? pluginId })}
            </p>
            <div className="bridge-confirm-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setConfirming(false)}
              >
                {t('confirmUninstallCancel')}
              </button>
              <button
                ref={confirmRef}
                type="button"
                className="button button-primary bridge-confirm-danger"
                onClick={() => void runUninstall()}
              >
                <Trash2 size={16} aria-hidden="true" />
                {t('confirmUninstallOk')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
