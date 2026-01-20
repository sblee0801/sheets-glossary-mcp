/**
 * src/mcp/index.mjs
 * - MCP 서버/툴 등록 + /mcp 엔드포인트 핸들러
 * - 기존 server.mjs의 MCP 동작(2 tools) 유지
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { ensureGlossaryLoaded } from "../cache/global.mjs";
import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs } from "../replace/replace.mjs";
import { normalizeLang, assertAllowedSourceLang, getParsedBody } from "../utils/common.mjs";

export function registerMcp(app) {
  // ---------------- MCP (ONLY 2 TOOLS) ----------------
  const mcp = new McpServer({
    name: "sheets-glossary-mcp",
    version: "2.4.2",
  });

  /**
   * MCP Tool #1: replace_texts
   */
  mcp.tool(
    "replace_texts",
    {
      texts: z.array(z.string()).min(1).max(2000),
      category: z.string().optional(),
      sourceLang: z.string().min(1),
      targetLang: z.string().min(1),
      includeLogs: z.boolean().optional(),
      forceReload: z.boolean().optional(),
    },
    async ({ texts, category, sourceLang, targetLang, includeLogs, forceReload }) => {
      const cache = await ensureGlossaryLoaded({ forceReload: Boolean(forceReload) });

      const sourceLangKey = normalizeLang(sourceLang);
      const targetLangKey = normalizeLang(targetLang);

      assertAllowedSourceLang(sourceLangKey);

      if (sourceLangKey === "en-us" && cache.langIndex["en-us"] == null) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: "Header does not include en-US. Cannot use sourceLang=en-US." },
                null,
                2
              ),
            },
          ],
        };
      }

      let categories = [];
      if (category && String(category).trim()) {
        const catKey = String(category).trim().toLowerCase();
        if (!cache.byCategoryBySource.has(catKey)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: `Category not found: ${category}` }, null, 2),
              },
            ],
          };
        }
        categories = [catKey];
      } else {
        categories = Array.from(cache.byCategoryBySource.keys());
      }

      const sourceTextMap = mergeSourceTextMapsFromCache(cache, sourceLangKey, categories);
      if (!sourceTextMap || sourceTextMap.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: `No source texts found for sourceLang='${sourceLangKey}' (category=${
                    category ? String(category) : "ALL"
                  }).`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const wantLogs = includeLogs ?? true;

      const outTexts = [];
      const perLineLogs = [];
      let replacedTotalAll = 0;
      let matchedTermsAll = 0;

      for (let i = 0; i < texts.length; i++) {
        const input = texts[i];
        const { out, replacedTotal, logs } = replaceByGlossaryWithLogs({
          text: input,
          sourceLangKey,
          targetLangKey,
          sourceTextMap,
        });

        outTexts.push(out);
        replacedTotalAll += replacedTotal;
        matchedTermsAll += logs.length;

        if (wantLogs) perLineLogs.push({ index: i, replacedTotal, logs });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                category: category ? String(category).trim().toLowerCase() : "ALL",
                sourceLang: sourceLangKey,
                targetLang: targetLangKey,
                texts: outTexts,
                summary: {
                  lines: texts.length,
                  replacedTotal: replacedTotalAll,
                  matchedTerms: matchedTermsAll,
                  glossaryLoadedAt: cache.loadedAt,
                  rawRowCount: cache.rawRowCount,
                  categoriesUsedCount: categories.length,
                  uniqueTermsInIndex: sourceTextMap.size,
                },
                logs: wantLogs ? perLineLogs : undefined,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  /**
   * MCP Tool #2: glossary_update
   */
  mcp.tool(
    "glossary_update",
    {
      forceReload: z.boolean().optional(),
    },
    async ({ forceReload }) => {
      const cache = await ensureGlossaryLoaded({ forceReload: forceReload ?? true });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                glossaryLoadedAt: cache.loadedAt,
                rawRowCount: cache.rawRowCount,
                categoriesCount: cache.byCategoryBySource.size,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // MCP endpoint
  app.all("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    res.on("close", () => transport.close());

    await mcp.connect(transport);

    const body = getParsedBody(req);
    await transport.handleRequest(req, res, body);
  });
}
