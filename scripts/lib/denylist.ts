import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Denylist fragments.
 *
 * `.scan-denylist` is one file, so two agents editing it at the same time
 * overwrite each other and silently lose entries. Fragments live in
 * `.scan-denylist.d/` where each file has one owner: appending a line never
 * touches another agent's file.
 *
 * `.scan-denylist` stays supported for the single-file case.
 */
export function readDenylist(root = "."): string[] {
  const files = [
    ...(existsSync(join(root, ".scan-denylist")) ? [join(root, ".scan-denylist")] : []),
    ...(existsSync(join(root, ".scan-denylist.d"))
      ? readdirSync(join(root, ".scan-denylist.d"))
          .filter((f) => f.endsWith(".txt"))
          .sort()
          .map((f) => join(root, ".scan-denylist.d", f))
      : []),
  ];
  const seen = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const term = line.trim();
      if (!term || term.startsWith("#")) continue;
      seen.add(term);
    }
  }
  return [...seen];
}
