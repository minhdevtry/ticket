/**
 * Prompt text lives in markdown, not in string literals, so it can be edited
 * without touching TypeScript. Bun inlines these at build time, which is what
 * keeps `bun build --compile` producing a self-contained binary.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
