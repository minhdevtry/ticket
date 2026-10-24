import type { TicketBindingRepository } from "../lib/storage/binding-repository";
import type { Notifier } from "./notifier";
import { getLogger } from "@vuihoc/bot-core/core";
import { stripCommentHtml } from "@vuihoc/bot-core/core";
import { stripBotMentions } from "../lib/formatting.local";
import { isCommentRecentlyForwarded } from "../lib/formatting.local";
import { decodeHtmlEntities } from "../lib/html-entities";
import { identifierInProject, normalizeProjectKey } from "@vuihoc/bot-core/itsaplan";

export interface AgentRunnerOptions {
  itsaplanBaseUrl: string;
  agentApiKey: string;
  bindingRepo: TicketBindingRepository;
  botAdapters: Map<string, Notifier>;
  agentHandles?: string[];
  itsaplanWebUrl?: string;
  pollIntervalMs?: number;
  /** Mã dự án worker phụ trách — binding dùng chung DB, run của dự án khác thì không gửi hộ. */
  projectKey?: string;
}

export interface ClaimedRun {
  id: number;
  trigger: string;
  prompt: string;
  systemPrompt?: string;
  attempts: number;
  issueId: number | null;
  issueIdentifier: string | null;
}

export class AgentRunnerService {
  private readonly baseUrl: string;
  private readonly agentApiKey: string;
  private readonly bindingRepo: TicketBindingRepository;
  private readonly botAdapters: Map<string, Notifier>;
  private readonly agentHandles: string[];
  private readonly itsaplanWebUrl: string;
  private readonly pollIntervalMs: number;
  private readonly projectKey: string | null;

  private running = false;
  private timer: Timer | null = null;
  private isProcessing = false;

  constructor(options: AgentRunnerOptions) {
    this.baseUrl = options.itsaplanBaseUrl.replace(/\/+$/, "");
    this.agentApiKey = options.agentApiKey;
    this.bindingRepo = options.bindingRepo;
    this.botAdapters = options.botAdapters;
    this.agentHandles = options.agentHandles || ["tieulinh", "vhticket_bot", "intake"];
    this.itsaplanWebUrl = (options.itsaplanWebUrl || options.itsaplanBaseUrl).replace(/\/+$/, "");
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.projectKey = normalizeProjectKey(options.projectKey);
  }

  start() {
    if (this.running) return;
    this.running = true;
    getLogger().info(
      `[AgentRunner] Bắt đầu runner với URL ${this.baseUrl} (chu kỳ: ${this.pollIntervalMs}ms)`,
    );
    this.scheduleNext(100);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    getLogger().info(`[AgentRunner] Đã dừng runner`);
  }

  private scheduleNext(delay: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => this.poll(), delay);
  }

  private async poll() {
    if (!this.running || this.isProcessing) return;
    this.isProcessing = true;

    let hasMore = false;
    try {
      const run = await this.claimRun();
      if (run) {
        hasMore = true;
        getLogger().info(
          `[AgentRunner] Đã nhận run #${run.id} (${run.issueIdentifier ?? run.issueId}) - trigger: ${run.trigger}`,
        );
        await this.handleRun(run);
      }
    } catch (err: any) {
      getLogger().warn(`[AgentRunner] Lỗi khi claim/xử lý run: ${err.message}`);
    } finally {
      this.isProcessing = false;
      this.scheduleNext(hasMore ? 500 : this.pollIntervalMs);
    }
  }

  private async claimRun(): Promise<ClaimedRun | null> {
    const res = await fetch(`${this.baseUrl}/agent-runs/claim`, {
      method: "POST",
      headers: {
        "x-api-key": this.agentApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`claimRun failed HTTP ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { run: ClaimedRun | null };
    return data?.run ?? null;
  }

  private async reportResult(
    runId: number,
    result: { status: "success" | "failed"; output?: string; error?: string },
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agent-runs/${runId}/result`, {
      method: "POST",
      headers: {
        "x-api-key": this.agentApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result),
    });

    if (!res.ok) {
      const text = await res.text();
      getLogger().warn(
        `[AgentRunner] reportResult cho run #${runId} thất bại: HTTP ${res.status} ${text}`,
      );
    }
  }

  extractCommentInfo(prompt: string): { cleanText: string; images: string[]; videos: string[] } {
    let raw = prompt;
    const marker = "The comment that mentioned you:";
    const markerIdx = prompt.lastIndexOf(marker);
    if (markerIdx !== -1) {
      raw = prompt.slice(markerIdx + marker.length).trim();
    }

    // Gỡ thẻ HTML (<mark>/<span>/<video>) rồi lọc mentions để bắt được cả @bot nằm trong thẻ màu
    let cleanText = stripBotMentions(stripCommentHtml(raw), this.agentHandles);

    const toAbsolute = (u: string) => {
      const clean = u.trim();
      if (clean.startsWith("http://127.0.0.1") || clean.startsWith("http://localhost")) {
        const pathPart = clean.replace(/^https?:\/\/[^/]+/, "");
        return `${this.itsaplanWebUrl}${pathPart.startsWith("/") ? pathPart : `/${pathPart}`}`;
      }
      return clean.startsWith("http://") || clean.startsWith("https://")
        ? clean
        : `${this.itsaplanWebUrl}${clean.startsWith("/") ? clean : `/${clean}`}`;
    };

    // Lọc ảnh markdown
    const mdRegex = /!\[.*?\]\((.*?)\)/g;
    const images: string[] = [];
    for (const match of raw.matchAll(mdRegex)) {
      if (match[1]) images.push(toAbsolute(match[1].trim()));
    }
    cleanText = cleanText.replace(/!\[.*?\]\(.*?\)/g, "").trim();

    // Markdown has no video syntax — Itsaplan embeds a video comment as a raw
    // <video src="…" controls></video> tag (xem attachmentMarkdown ở web).
    const videoRegex = /<video\b[^>]*\bsrc="([^"]*)"[^>]*>/gi;
    const videos: string[] = [];
    for (const match of raw.matchAll(videoRegex)) {
      if (match[1]) videos.push(toAbsolute(match[1].trim()));
    }
    cleanText = decodeHtmlEntities(stripCommentHtml(cleanText)).trim();

    return { cleanText, images, videos };
  }

  async handleRun(run: ClaimedRun): Promise<void> {
    if (!run.issueId && !run.issueIdentifier) {
      await this.reportResult(run.id, {
        status: "success",
        output: "Bỏ qua run không gắn với issue nào",
      });
      return;
    }

    // Tra cứu thông tin người báo lỗi
    const binding =
      (run.issueId ? this.bindingRepo.getBindingByIssueId(run.issueId) : null) ||
      (run.issueIdentifier ? this.bindingRepo.getBindingByIdentifier(run.issueIdentifier) : null);

    if (!binding) {
      getLogger().info(
        `[AgentRunner] Không tìm thấy binding Telegram cho ${run.issueIdentifier ?? run.issueId}, hoàn tất run`,
      );
      await this.reportResult(run.id, {
        status: "success",
        output: `Ticket ${run.issueIdentifier} không có binding Telegram (tạo nội bộ trên Itsaplan)`,
      });
      return;
    }

    // Hai worker chung file binding: run nhắc tới ticket dự án khác mà gửi đi
    // thì người báo nhận tin bằng nhầm bot. Không rõ dự án cũng không gửi.
    const runIdentifier = run.issueIdentifier || binding.identifier;
    if (
      !identifierInProject(runIdentifier, this.projectKey) ||
      !identifierInProject(binding.identifier, this.projectKey)
    ) {
      getLogger().info(
        `[AgentRunner] Run #${run.id} (${runIdentifier}) không thuộc dự án ${this.projectKey}, bỏ qua.`,
      );
      await this.reportResult(run.id, {
        status: "success",
        output: `Bỏ qua: ${runIdentifier} không thuộc dự án ${this.projectKey}`,
      });
      return;
    }

    const botAdapter = this.botAdapters.get(binding.channelType);
    if (!botAdapter) {
      getLogger().warn(`[AgentRunner] Không tìm thấy bot adapter cho kênh: ${binding.channelType}`);
      await this.reportResult(run.id, {
        status: "failed",
        error: `Không hỗ trợ kênh chat: ${binding.channelType}`,
      });
      return;
    }

    const { cleanText, images, videos } = this.extractCommentInfo(run.prompt);
    if (!cleanText && images.length === 0 && videos.length === 0) {
      getLogger().info(`[AgentRunner] Nội dung bình luận trống sau khi lọc mention`);
      await this.reportResult(run.id, {
        status: "success",
        output: "Bình luận trống",
      });
      return;
    }

    // Kiểm tra trùng lặp nếu Webhook đã gửi bình luận này trước đó
    if (isCommentRecentlyForwarded(binding.issueId, cleanText)) {
      getLogger().info(
        `[AgentRunner] Comment trên ${binding.identifier} đã được chuyển tiếp trước đó, bỏ qua gửi trùng.`,
      );
      await this.reportResult(run.id, {
        status: "success",
        output: `Đã được chuyển tiếp trước đó tới ${binding.channelType}:${binding.chatId}`,
      });
      return;
    }

    try {
      const authorName = binding.identifier.startsWith("PO-")
        ? "Product team"
        : "Kỹ thuật viên Itsaplan";
      const sentMessageId =
        images.length > 0 || videos.length > 0
          ? await botAdapter.notifyComment(binding, authorName, cleanText, images, videos)
          : await botAdapter.notifyComment(binding, authorName, cleanText);

      if (sentMessageId !== undefined && sentMessageId !== null) {
        this.bindingRepo.saveMessageRoute(
          String(sentMessageId),
          binding.channelType,
          binding.issueId,
          binding.identifier,
          binding.chatId,
          "comment",
        );
      }

      await this.reportResult(run.id, {
        status: "success",
        output: `Đã gửi thông báo tới ${binding.channelType}:${binding.chatId}`,
      });
      getLogger().info(
        `[AgentRunner] Đã gửi thông báo thành công cho run #${run.id} (${binding.identifier})`,
      );
    } catch (err: any) {
      getLogger().error(`[AgentRunner] Lỗi khi gửi thông báo tới Telegram: ${err.message}`);
      await this.reportResult(run.id, {
        status: "failed",
        error: err.message,
      });
    }
  }
}
