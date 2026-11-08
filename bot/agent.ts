import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  name: "A股基本面研究",
  description: "基于已采集的证据回答单只沪深 A 股公司的基本面问题。",
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
});
