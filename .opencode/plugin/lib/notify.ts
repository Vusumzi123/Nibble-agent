// Shared in-app toast notifier for the hooks. Wraps `client.tui.showToast`
// with the gating, headless-safety, and body shape the hooks all used inline.
// A missing/headless renderer is a silent no-op; a throwing renderer is routed
// to `onError` (or swallowed when none is given), so a toast can never disturb
// a write path.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.

export type ToastVariant = "info" | "success" | "warning" | "error"

// Minimal structural view of the opencode client the notifier needs. Loose on
// purpose: keeps this module free of SDK imports and unit-testable with a plain
// mock, while the real client remains assignable.
export type NotifierClient = {
  tui?: { showToast?(args: any): Promise<unknown> }
}

export type Notifier = {
  toast(message: string, variant?: ToastVariant): Promise<void>
}

export function createNotifier(opts: {
  client: NotifierClient
  directory: string
  enabled: boolean
  channel: string
  onError?: (err: unknown) => void
}): Notifier {
  const toast = async (message: string, variant: ToastVariant = "info"): Promise<void> => {
    if (!opts.enabled) return
    const showToast = opts.client.tui?.showToast
    if (!showToast) return
    try {
      await showToast({
        body: {
          title: opts.channel,
          message,
          variant,
          duration: variant === "error" ? 8000 : 5000,
        },
        query: { directory: opts.directory },
      })
    } catch (err) {
      opts.onError?.(err)
    }
  }
  return { toast }
}
