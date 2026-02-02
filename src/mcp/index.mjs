// src/mcp/index.mjs
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { ensureGlossaryLoaded } from "../cache/global.mjs";
import { mergeSourceTextMapsFromCache } from "../glossary/index.mjs";
import { replaceByGlossaryWithLogs } from "../replace/replace.mjs";
import { normalizeLang, assertAllowedSourceLang, getParsedBody } from "../utils/common.mjs";

// 줄바꿈 처리 함수 추가
function formatTextWithLineBreaks(text) {
  if (typeof text === 'string') {
    return text.replace(/\n/g, "<br>");
  }
  return text;
}

export function registerMcp(app) {
  const mcp = new McpServer({
    name: "sheets-glossary-mcp",
    version: "2.5.0",
  });

  mcp.tool(
    "replace_texts",
    {
      sheet: z.string().optional(),
      texts: z.array(z.string()).min(1).max(2000),
      category: z.string().optional(),
      sourceLang: z.enum(["en-US", "ko-KR"]).min(1),  // sourceLang은 "en-US", "ko-KR"만 허용
      targetLang: z.array(z.string()).min(1),  // targetLang은 다국어 지원 (배열로 여러 언어 지원)
      includeLogs: z.boolean().optional(),
      forceReload: z.boolean().optional(),
    },
    async ({ sheet, texts, category, sourceLang, targetLang, includeLogs, forceReload }) => {
      const cache = await ensureGlossaryLoaded({
        sheetName: sheet || "Glossary",
        forceReload: Boolean(forceReload),
      });

      const sourceLangKey = normalizeLang(sourceLang);  // normalizeLang 적용
      const wantLogs = includeLogs ?? true;

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
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Category not found: ${category}` }, null, 2) }],
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

      const outTexts = [];
      const perLineLogs = [];
      let replacedTotalAll = 0;
      let matchedTermsAll = 0;

      // 여러 targetLang을 지원하도록 처리
      for (let i = 0; i < texts.length; i++) {
        const input = texts[i];
        for (const targetLangKey of targetLang) {
          const { out, replacedTotal, logs } = replaceByGlossaryWithLogs({
            text: input,
            sourceLangKey,
            targetLangKey: normalizeLang(targetLangKey),
            sourceTextMap,
          });

          outTexts.push(formatTextWithLineBreaks(out));  // 줄바꿈 처리
          replacedTotalAll += replacedTotal;
          matchedTermsAll += logs.length;

          if (wantLogs) perLineLogs.push({ index: i, replacedTotal, logs });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                sheet: cache.sheetName,
                category: category ? String(category).trim().toLowerCase() : "ALL",
                sourceLang: sourceLangKey,
                targetLangs: targetLang,  // 여러 targetLang을 함께 반환
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

  mcp.tool(
    "glossary_update",
    {
      sheet: z.string().optional(),
      forceReload: z.boolean().optional(),
    },
    async ({ sheet, forceReload }) => {
      const cache = await ensureGlossaryLoaded({
        sheetName: sheet || "Glossary",
        forceReload: forceReload ?? true,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                sheet: cache.sheetName,
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
