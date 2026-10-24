import { describe, expect, mock, test } from "bun:test";
import { AgentRunnerService, type ClaimedRun } from "./agent-runner";
import { OnyxIngestService } from "./ingest.service";
import type { TicketBinding, TicketBindingRepository } from "../lib/storage/binding-repository";
import type { Notifier } from "./notifier";

function runner(binding: TicketBinding, projectKey?: string) {
  const adapter = {
    channelType: "telegram",
    notifyComment: mock(async () => "m-1"),
    notifyStateChange: mock(async () => "m-2"),
  } as unknown as Notifier;
  const repo = {
    getBindingByIssueId: mock(() => binding),
    getBindingByIdentifier: mock(() => binding),
    saveMessageRoute: mock(() => {}),
  } as unknown as TicketBindingRepository;
  const service = new AgentRunnerService({
    itsaplanBaseUrl: "http://itsaplan.invalid",
    agentApiKey: "k",
    bindingRepo: repo,
    botAdapters: new Map([["telegram", adapter]]),
    projectKey,
  });
  const reports: any[] = [];
  (service as any).reportResult = async (_id: number, result: any) => reports.push(result);
  return { service, adapter, reports };
}

function run(identifier: string, text: string): ClaimedRun {
  return {
    id: 1,
    trigger: "mention",
    prompt: `The comment that mentioned you: @iris ${text}`,
    attempts: 1,
    issueId: 5,
    issueIdentifier: identifier,
  };
}

describe("AgentRunnerService — khoá dự án", () => {
  test("run của dự án khác (binding chung DB) không gửi qua bot này", async () => {
    const { service, adapter, reports } = runner(
      { issueId: 5, channelType: "telegram", chatId: "c", messageId: "1", identifier: "TECH-5" },
      "PO",
    );
    await (service as any).handleRun(run("TECH-5", "khoá dự án 1"));
    expect(adapter.notifyComment).not.toHaveBeenCalled();
    expect(reports[0].status).toBe("success");
  });

  test("run của dự án mình vẫn gửi và lưu route kèm chat", async () => {
    const { service, adapter } = runner(
      { issueId: 5, channelType: "telegram", chatId: "c", messageId: "1", identifier: "PO-5" },
      "PO",
    );
    await (service as any).handleRun(run("PO-5", "khoá dự án 2"));
    expect(adapter.notifyComment).toHaveBeenCalledTimes(1);
  });

  test("gỡ thẻ <mark>, <span> tô màu và <video> khi chuyển bình luận về Telegram", async () => {
    const binding: TicketBinding = {
      issueId: 5,
      channelType: "telegram",
      chatId: "c",
      messageId: "1",
      identifier: "PO-5",
    };
    const { service, adapter } = runner(binding, "PO");
    await service.handleRun(
      run(
        "PO-5",
        '<mark data-color="#fef08a" style="background-color: #fef08a">Cập nhật</mark> bản <span style="color: #ef4444">thiết kế mới</span> <video src="/media/demo.mp4" controls></video>',
      ),
    );
    expect(adapter.notifyComment).toHaveBeenCalledWith(
      binding,
      "Product team",
      "Cập nhật bản thiết kế mới",
      [],
      ["http://itsaplan.invalid/media/demo.mp4"],
    );
  });
});

describe("OnyxIngestService — khoá dự án", () => {
  test("ticket không thuộc dự án worker thì bỏ qua, không gọi LLM/Onyx", async () => {
    const itsaplan = {
      getIssue: mock(async () => ({ id: 78, identifier: "PO-78", title: "x", description: "y" })),
      getIssueTimeline: mock(async () => []),
    } as any;
    const service = new OnyxIngestService(
      itsaplan,
      {} as any,
      {
        onyxBaseUrl: "http://onyx.invalid",
        onyxApiKey: "k",
        openaiBaseUrl: "",
        openaiApiKey: "",
        openaiModel: "m",
        itsaplanWebUrl: "",
        itsaplanProjectKey: "TECH",
        docIdPrefix: "ticket_",
      } as any,
    );

    const result = await service.ingestDoneTicket(78);
    expect(result).toMatchObject({ success: true, status: "skipped" });
    expect(itsaplan.getIssueTimeline).not.toHaveBeenCalled();
  });
});
