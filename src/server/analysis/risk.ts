import type { PeriodDrawdown, RatioView, RiskItem } from "../../shared/types";

export interface RiskInput {
  ratios: RatioView | null;
  previousDebt: number | null;
  drawdowns: PeriodDrawdown[];
  negativeNews: number;
  newsEvidenceIds: string[];
  generalManager: string | null;
  managerEvidenceId: string | null;
  policyEvidenceIds: string[];
}

export function assessRisks(input: RiskInput): RiskItem[] {
  const ratioIds = input.ratios?.evidenceIds ?? [];
  const debt = input.ratios?.debtToAsset ?? null;
  const yearly = input.drawdowns.find((item) => item.period === "year");
  return [
    debtRisk(debt, input.previousDebt, ratioIds),
    drawdownRisk(yearly),
    {
      name: "舆情与经营报道",
      impact: input.negativeNews >= 3 ? 2 : null,
      probability: input.negativeNews >= 3 ? 1 : null,
      rationale: input.negativeNews > 0
        ? `本次样本中有 ${input.negativeNews} 条负面关键词报道或评论。关键词只用于检索，不能单独定性重大风险。`
        : "本次样本没有命中负面关键词。",
      evidenceIds: input.newsEvidenceIds,
    },
    {
      name: "董事会与管理层",
      impact: input.generalManager?.includes("代") ? 2 : 1,
      probability: 1,
      rationale: input.generalManager?.includes("代")
        ? `总经理字段为“${input.generalManager}”，存在代理任职标记。这只说明任职状态需关注，不是违规结论。`
        : "本次公开概况未显示总经理代理任职，也未抓取到董事会处罚证据。",
      evidenceIds: input.managerEvidenceId ? [input.managerEvidenceId] : [],
    },
    {
      name: "政策与外部环境",
      impact: input.policyEvidenceIds.length > 0 ? 2 : null,
      probability: input.policyEvidenceIds.length > 0 ? 1 : null,
      rationale: input.policyEvidenceIds.length > 0
        ? "公告、新闻或本地材料命中政策、海关、监管或地缘关键词。需要回到原文确认传导路径。"
        : "本次材料未命中可直接归因的政策、海关或地缘政治关键词，不能据此判断不受政策影响。",
      evidenceIds: input.policyEvidenceIds,
    },
  ];
}

function debtRisk(debt: number | null, previous: number | null, evidenceIds: string[]): RiskItem {
  if (debt === null) {
    return { name: "资产负债率", impact: null, probability: null, rationale: "缺少可比的资产或负债数据，不计算负债风险等级。", evidenceIds };
  }
  const rising = previous !== null && debt - previous >= 0.05;
  return {
    name: "资产负债率",
    impact: debt > 0.7 ? 3 : debt > 0.5 ? 2 : 1,
    probability: rising ? 2 : 1,
    rationale: `按总负债除以总资产为 ${(debt * 100).toFixed(2)}%。这是规则化初筛：50% 以下为低、50%–70% 为中、70% 以上为高，不是信用评级。`,
    evidenceIds,
  };
}

function drawdownRisk(drawdown: PeriodDrawdown | undefined): RiskItem {
  if (!drawdown?.complete || !drawdown.result) {
    return {
      name: "年度最大回撤",
      impact: null,
      probability: null,
      rationale: "价格样本未覆盖完整年度，不把部分区间回撤标成年度风险。",
      evidenceIds: drawdown?.evidenceId ? [drawdown.evidenceId] : [],
    };
  }
  const rate = drawdown.result.rate;
  return {
    name: "年度最大回撤",
    impact: rate <= -0.4 ? 3 : rate <= -0.2 ? 2 : 1,
    probability: null,
    rationale: `近一年已实现最大回撤为 ${(rate * 100).toFixed(2)}%。回撤描述历史路径，不外推未来发生概率。`,
    evidenceIds: drawdown.evidenceId ? [drawdown.evidenceId] : [],
  };
}
