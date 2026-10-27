declare module "*/iris-tuong-tac/index.mjs" {
  export function choPhepNutTrenTinCoMa(text: string, buttons?: unknown): boolean;
  export function laCallbackNoiBo(body: string): boolean;
  export function xuLyDebounceCallback(
    body: string,
    sessionKey: string,
    senderId: string,
    daThay?: Map<string, number>,
  ): boolean;
  export function layAccountId(ctx?: unknown, event?: unknown): string | null;
  export function donDepVanBanKhiCoNut(text: string, buttons?: unknown): string;
  export function locSuyNghiVaBanNhap(text: string): string;
  export function duongEnvMcp(): string;
  export function duongCauHinh(env?: NodeJS.ProcessEnv): string;
  export function layBotToken(
    accountId?: string | null,
    env?: NodeJS.ProcessEnv,
    duongJson?: string | null,
  ): string | null;
  const plugin: { id: string; name: string; register(api: unknown): void };
  export default plugin;
}

declare module "*/xac-nhan-xong/index.mjs" {
  export function docXacNhan(noiDung: string): number | null;
  export function layChatId(ctx?: unknown, event?: unknown): string;
  export function layReplyToId(
    noiDung?: string | null,
    ctx?: unknown,
    event?: unknown,
  ): string | null;
  export function boPhongBiKenh(text: string): string;
  export function laLenhSuCoMoi(body?: string): boolean;
  export function docBangWorker(env?: NodeJS.ProcessEnv): Record<string, string>;
  export function xuLyXacNhan(
    event: unknown,
    ctx: unknown,
    deps: unknown,
  ): Promise<{ handled?: boolean; reply?: { text: string }; reason?: string } | undefined>;
  export function xuLyTruocDispatch(
    event: unknown,
    ctx: unknown,
    deps: unknown,
  ): Promise<{ handled?: boolean; text?: string } | undefined>;
  const plugin: { id: string; name: string; register(api: unknown): void };
  export default plugin;
}
