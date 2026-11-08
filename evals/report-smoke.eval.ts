import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  test: async (t) => {
    await t.send("请基于已采集证据说明这只股票最新报告期的资产负债率，并给出证据编号。不要提供买卖建议。");
    t.succeeded();
    t.calledTool("search-evidence");
  },
});
