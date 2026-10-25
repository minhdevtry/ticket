import { getLogger } from "@vuihoc/bot-core/core";
export interface OnyxTestConnectorConfig {
  connectorName: string;
  ccPairId: number;
  documentSetId: number;
  documentSetName: string;
}

export interface OnyxConnectorManagerOptions {
  connectorName?: string;
  documentSetName?: string;
  ccPairId?: number;
}

export class OnyxConnectorManager {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly connectorName: string;
  private readonly documentSetName: string;
  private readonly ccPairId?: number;

  constructor(baseUrl: string, apiKey: string, options?: OnyxConnectorManagerOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.connectorName =
      options?.connectorName || process.env.ONYX_CONNECTOR_NAME || "FileConnector-IntakeTest-Done";
    this.documentSetName =
      options?.documentSetName || process.env.ONYX_DOCUMENT_SET || "intake-test-done";
    // ONYX_CC_PAIR_ID trong .env chỉ được ngầm hiểu là cc-pair của document set
    // MẶC ĐỊNH ("intake-test-done") — nếu caller truyền connectorName/documentSetName
    // riêng (ví dụ tạo 1 connector khác hoàn toàn), TUYỆT ĐỐI không được kế thừa
    // ccPairId của set mặc định, kẻo ghi nhầm document vào set không liên quan.
    // (Đã xảy ra thật một lần — xem docs/KG_CAUSE_TAXONOMY.md hoặc lịch sử sửa.)
    const usingDefaultIdentity = !options?.connectorName && !options?.documentSetName;
    this.ccPairId =
      options?.ccPairId ??
      (usingDefaultIdentity && process.env.ONYX_CC_PAIR_ID
        ? parseInt(process.env.ONYX_CC_PAIR_ID, 10)
        : undefined);
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Ensures that the isolated test connector, cc-pair, and document set exist on Onyx.
   * If already present, returns the existing configuration (idempotent).
   */
  async ensureTestConnector(): Promise<OnyxTestConnectorConfig> {
    if (!this.apiKey) {
      throw new Error("ONYX_API_KEY is not configured.");
    }

    // 0. If explicit CC-Pair ID is provided via config/env, reuse directly
    if (this.ccPairId) {
      return {
        connectorName: this.connectorName,
        ccPairId: this.ccPairId,
        documentSetId: 14,
        documentSetName: this.documentSetName,
      };
    }

    // 1. Check if Document Set already exists
    const dsListRes = await fetch(`${this.baseUrl}/api/manage/document-set`, {
      headers: this.headers,
    });

    if (dsListRes.ok) {
      const docSets = (await dsListRes.json()) as any[];
      const existingDs = docSets.find((d) => d.name === this.documentSetName);

      if (existingDs && existingDs.cc_pair_summaries && existingDs.cc_pair_summaries.length > 0) {
        const ccPairId = existingDs.cc_pair_summaries[0].id;
        return {
          connectorName: this.connectorName,
          ccPairId,
          documentSetId: existingDs.id,
          documentSetName: this.documentSetName,
        };
      }
    }

    // 2. Create Connector + CC-Pair with mock credential
    const createConnRes = await fetch(
      `${this.baseUrl}/api/manage/admin/connector-with-mock-credential`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          name: this.connectorName,
          source: "file",
          input_type: "load_state",
          connector_specific_config: {
            file_names: [],
            file_locations: [],
            zip_metadata_file_id: null,
          },
          refresh_freq: null,
          prune_freq: null,
          indexing_start: null,
          access_type: "private",
          groups: [8],
        }),
      },
    );

    if (!createConnRes.ok) {
      const errText = await createConnRes.text();
      throw new Error(`Failed to create Onyx connector: ${createConnRes.status} - ${errText}`);
    }

    const connBody = (await createConnRes.json()) as any;
    const ccPairId = typeof connBody === "number" ? connBody : connBody.data || connBody.id;

    if (!ccPairId) {
      throw new Error(
        `Failed to retrieve CC-Pair ID from Onyx response: ${JSON.stringify(connBody)}`,
      );
    }

    // 3. Create Document Set
    const createDsRes = await fetch(`${this.baseUrl}/api/manage/admin/document-set`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        name: this.documentSetName,
        description: "Kho tri thức thử nghiệm tự động nạp từ các ticket đã Resolved/Done",
        cc_pair_ids: [ccPairId],
        is_public: false,
        users: [],
        groups: [8],
      }),
    });

    if (!createDsRes.ok) {
      const errText = await createDsRes.text();
      throw new Error(`Failed to create Onyx document set: ${createDsRes.status} - ${errText}`);
    }

    const dsBody = (await createDsRes.json()) as any;
    const documentSetId = typeof dsBody === "number" ? dsBody : dsBody.id || dsBody.data;

    // 4. Update User Group 8 (TicketAgent Department Group)
    try {
      const groupRes = await fetch(`${this.baseUrl}/api/manage/admin/user-group`, {
        headers: this.headers,
      });
      if (groupRes.ok) {
        const groups = (await groupRes.json()) as any[];
        const group8 = groups.find((g: any) => g.id === 8);
        if (group8) {
          const existingCc =
            group8.cc_pairs?.map((c: any) => (typeof c === "object" ? c.id : c)) || [];
          const existingDs =
            group8.document_sets?.map((d: any) => (typeof d === "object" ? d.id : d)) || [];
          const existingUsers =
            group8.users?.map((u: any) => (typeof u === "object" ? u.id : u)) || [];

          await fetch(`${this.baseUrl}/api/manage/admin/user-group/8`, {
            method: "PATCH",
            headers: this.headers,
            body: JSON.stringify({
              name: group8.name,
              user_ids: existingUsers,
              cc_pair_ids: Array.from(new Set([...existingCc, ccPairId])),
              document_set_ids: Array.from(new Set([...existingDs, documentSetId])),
            }),
          });
        }
      }
    } catch (e: any) {
      getLogger().warn("[OnyxConnectorManager] Warning updating User Group 8:", e.message);
    }

    // 5. Update Persona 6 (Telegram TicketAgent Assistant) and Persona 8 (TEST KG Assistant)
    for (const personaId of [6, 8]) {
      try {
        const pRes = await fetch(`${this.baseUrl}/api/persona/${personaId}`, {
          headers: this.headers,
        });
        if (pRes.ok) {
          const persona = (await pRes.json()) as any;
          const existingDocsets = persona.document_sets?.map((d: any) => d.id) || [];
          const mergedPersonaDs = Array.from(new Set([...existingDocsets, documentSetId]));

          await fetch(`${this.baseUrl}/api/persona/${personaId}`, {
            method: "PATCH",
            headers: this.headers,
            body: JSON.stringify({
              name: persona.name,
              description: persona.description,
              system_prompt: persona.system_prompt,
              task_prompt: persona.task_prompt || "",
              datetime_aware: persona.datetime_aware ?? true,
              num_chunks: persona.num_chunks,
              llm_relevance_filter: persona.llm_relevance_filter ?? true,
              is_public: persona.is_public ?? true,
              document_set_ids: mergedPersonaDs,
              tool_ids: persona.tools?.map((t: any) => t.id) || (personaId === 8 ? [] : [1]),
            }),
          });
        }
      } catch (e: any) {
        getLogger().warn(
          `[OnyxConnectorManager] Warning updating Persona ${personaId}:`,
          e.message,
        );
      }
    }

    return {
      connectorName: this.connectorName,
      ccPairId,
      documentSetId,
      documentSetName: this.documentSetName,
    };
  }
}
