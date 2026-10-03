import type { InboundMessage } from "../types.js";

/**
 * Example channel adapter, interface only. Shows how a platform payload is
 * flattened into `InboundMessage` without the pipeline ever importing a bot
 * library. No token, no network: the long-polling or webhook loop that feeds
 * `fromTelegramUpdate` belongs to the application, not to this package.
 */
export interface ChannelAdapter {
  /** Start receiving; the handler is the pipeline. */
  start(onMessage: (message: InboundMessage) => Promise<{ reply: string | null }>): Promise<void>;
  sendText(chatRef: string, text: string): Promise<void>;
}

/** Only the fields we read, typed structurally so no Telegram types package is needed. */
export interface TelegramUpdateLike {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type?: string };
    from?: { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; width?: number; height?: number }>;
    voice?: { file_id: string };
    audio?: { file_id: string };
    document?: { file_id: string; file_name?: string; mime_type?: string };
  };
}

/** Returns null for updates that are not messages (edits, reactions, joins). Bots talking to bots are ignored too. */
export function fromTelegramUpdate(update: TelegramUpdateLike): InboundMessage | null {
  const m = update.message;
  if (!m || !m.from || m.from.is_bot) return null;

  const text = m.text ?? m.caption;
  const kind: InboundMessage["kind"] = m.photo?.length ? "photo" : m.voice || m.audio ? "audio" : m.document ? "document" : "text";
  // Telegram sends several sizes of the same photo; the last one is the largest.
  const mediaRef = m.photo?.at(-1)?.file_id ?? m.voice?.file_id ?? m.audio?.file_id ?? m.document?.file_id;
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || String(m.from.id);

  return {
    id: `${m.chat.id}:${m.message_id}`,
    channel: "telegram",
    chatRef: String(m.chat.id),
    sender: { ref: String(m.from.id), name },
    kind,
    ...(text !== undefined && { text }),
    ...(mediaRef !== undefined && { mediaRef }),
    sentAt: new Date(m.date * 1000).toISOString(),
  };
}
