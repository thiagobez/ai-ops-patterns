import { describe, expect, it } from "vitest";
import { fromTelegramUpdate } from "../src/adapters/telegram.js";

describe("fromTelegramUpdate", () => {
  const from = { id: 42, first_name: "Dana", last_name: "Q" };
  const chat = { id: -1001, type: "supergroup" };

  it("maps a text message", () => {
    const m = fromTelegramUpdate({ update_id: 1, message: { message_id: 7, date: 1_790_000_000, chat, from, text: "Slab poured" } });
    expect(m).toEqual({
      id: "-1001:7", channel: "telegram", chatRef: "-1001", sender: { ref: "42", name: "Dana Q" }, kind: "text", text: "Slab poured",
      sentAt: new Date(1_790_000_000_000).toISOString(),
    });
  });

  it("picks the largest photo and uses the caption as text", () => {
    const m = fromTelegramUpdate({
      update_id: 2,
      message: { message_id: 8, date: 1_790_000_000, chat, from, caption: "invoice", photo: [{ file_id: "small" }, { file_id: "large" }] },
    });
    expect(m).toMatchObject({ kind: "photo", text: "invoice", mediaRef: "large" });
  });

  it("maps voice and documents, and ignores non-message updates and bots", () => {
    expect(fromTelegramUpdate({ update_id: 3, message: { message_id: 9, date: 1, chat, from, voice: { file_id: "v1" } } })).toMatchObject({ kind: "audio", mediaRef: "v1" });
    expect(fromTelegramUpdate({ update_id: 4, message: { message_id: 10, date: 1, chat, from, document: { file_id: "d1", file_name: "inv.pdf" } } })).toMatchObject({ kind: "document", mediaRef: "d1" });
    expect(fromTelegramUpdate({ update_id: 5 })).toBeNull();
    expect(fromTelegramUpdate({ update_id: 6, message: { message_id: 11, date: 1, chat, from: { id: 1, is_bot: true }, text: "hi" } })).toBeNull();
  });
});
