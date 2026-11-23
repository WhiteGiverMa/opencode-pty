import type { Plugin } from '@opencode/plugin'
import type { SessionNotifier } from '../adapters/types.ts'
import { buildExitNotification } from '../plugin/pty/notification-manager.ts'
import type { PTYSession } from '../plugin/pty/types.ts'

/**
 * The subset of opencode v2's plugin `session` domain we use to wake a session.
 *
 * The full domain (`Plugin.Context["session"]`) also exposes `get`,
 * `switchModel`, `wait`, `context` and more; keeping the notifier bound to
 * `prompt` only makes it easy to construct in tests and resilient to hosts
 * that only expose part of the surface.
 */
export type V2SessionPrompt = {
  readonly synthetic?: Plugin.Context['session']['synthetic']
  readonly prompt?: Plugin.Context['session']['prompt']
}

function exitNotificationMessageId(sessionId: string): string {
  const normalized = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
  return `msg_pty_${normalized}_exited`
}

function exitNotificationDescription(session: PTYSession, exitCode: number): string {
  const cmd = [session.command, ...session.args].join(' ').replace(/\s+/g, ' ').trim()
  const label = session.title?.trim() || cmd || session.id
  return session.timedOut
    ? `PTY timed out (${session.id}): ${label}`
    : exitCode === 0
      ? `PTY finished (${session.id}): ${label}`
      : `PTY exited ${exitCode} (${session.id}): ${label}`
}

/**
 * Delivers `<pty_exited>` notifications through opencode v2's plugin context.
 *
 * Prefers OpenCode v2's native `session.synthetic` inbox channel (the same
 * mechanism built-in background shells and subagents use) with a deterministic
 * `msg_pty_<id>_exited` message ID (`SessionMessage.ID` requires a `msg_`
 * prefix), so `SessionInbox.reconcile` makes repeated deliveries idempotent
 * (e.g. when a kill races the process exit) and TUI renders a compact notice
 * row instead of a fake human bubble. Falls back to `session.prompt` on hosts
 * or test doubles that only expose `prompt`.
 *
 * Delivery failures are logged instead of swallowed, so a dead wake-up is
 * never indistinguishable from "the model decided not to respond".
 */
export class V2SessionNotifier implements SessionNotifier {
  constructor(private readonly session: V2SessionPrompt) {}

  async sendExitNotification(session: PTYSession, exitCode: number): Promise<void> {
    if (!session.parentSessionId) {
      console.warn(`[opencode-pty] cannot notify: session ${session.id} has no parent session`)
      return
    }

    const id = exitNotificationMessageId(session.id)
    const text = buildExitNotification(session, exitCode)
    try {
      if (typeof this.session.synthetic === 'function') {
        const state = session.timedOut ? 'cancelled' : exitCode === 0 ? 'completed' : 'error'
        await this.session.synthetic({
          sessionID: session.parentSessionId,
          id,
          text,
          description: exitNotificationDescription(session, exitCode),
          metadata: {
            source: 'pty',
            ptyID: session.id,
            exitCode,
            timedOut: Boolean(session.timedOut),
            state,
          },
        })
        return
      }
      if (typeof this.session.prompt === 'function') {
        await this.session.prompt({
          sessionID: session.parentSessionId,
          id,
          text,
        })
        return
      }
      console.warn('[opencode-pty] host session exposes neither synthetic nor prompt')
    } catch (error) {
      console.error(
        `[opencode-pty] failed to deliver exit notification for ${session.id}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}
