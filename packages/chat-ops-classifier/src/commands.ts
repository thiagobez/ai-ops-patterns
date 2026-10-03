/**
 * Slash commands the group can type. Parsing only; execution and role checks
 * live in the pipeline so a dashboard button goes through the same gate.
 */
export type Command =
  | { name: "status" }
  | { name: "pending" }
  | { name: "help" }
  | { name: "done"; id: string }
  | { name: "confirm"; id: string; force: boolean }
  | { name: "discard"; id: string; reason: string };

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // `/status@my_bot` is how some platforms address a specific bot in a group.
  const [head = "", ...rest] = trimmed.slice(1).split(/\s+/);
  const name = head.split("@")[0]?.toLowerCase() ?? "";
  switch (name) {
    case "status":
      return { name: "status" };
    case "pending":
      return { name: "pending" };
    case "help":
      return { name: "help" };
    case "done":
      return rest[0] ? { name: "done", id: rest[0] } : { name: "help" };
    case "confirm":
      return rest[0] ? { name: "confirm", id: rest[0], force: rest[1]?.toLowerCase() === "force" } : { name: "help" };
    case "discard":
      return rest[0] ? { name: "discard", id: rest[0], reason: rest.slice(1).join(" ") || "no reason given" } : { name: "help" };
    default:
      return null; // not ours; some other bot or just text starting with a slash
  }
}
