import { z } from "zod";

const cursorSchema = z.object({
  value: z.union([z.string(), z.number()]),
  id: z.string().uuid(),
});

export type ListCursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(cursor: string): ListCursor {
  return cursorSchema.parse(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
  );
}
