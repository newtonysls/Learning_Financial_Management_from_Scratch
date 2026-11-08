import type { EvidenceRecord, ResearchPackage, ReportDocument } from "../../shared/types";
import { formatNumber, formatPercent, formatShanghai, formatYi } from "../analysis/text";
import { cite, validateCitations } from "./citations";

export function generateDeterministicReport(pkg: ResearchPackage): ReportDocument {
  const name = pkg.profile?.name || pkg.quote?.name || pkg.stock.canonical;
  const sections = [
    `# ${name}（${pkg.stock.canonical}）基本面研究报告`,
    metadata(pkg),
    summary(pkg, name),
    introduction(pkg, name),
    news(pkg),
    risks(pkg),
    opinion(pkg),
    "## 风险矩阵",
    riskMatrix(pkg),
    "## 舆情与媒体观点",
    opinionDetail(pkg),
    scenarios(pkg),
    limitations(pkg),
    bibliography(pkg.evidence),
  ];
  const markdown = sections.filter(Boolean).join("\n\n");
  const validation = validateCitations(markdown, pkg.evidence);
  if (!validation.valid) throw new Error(`报告引用校验失败：${validation.unknown.join(",")}`);
  return { title: `${name}基本面研究报告`, markdown, citations: validation.cited };
}

function metadata(pkg: ResearchPackage): string {
  const failures = pkg.failures.length > 0 ? pkg.failures.map((item) => `${item.source}：${item.message}`).join("；") : "无";
  return [
    `生成时间：${formatShanghai(pkg.generatedAt)}`,
    `证据数量：${pkg.evidence.length}`,
    `采集失败：${failures}`,
    "本报告区分事实、计算与推断。未附引用编号的判断不应被视为已核实事实。",
  ].join("\n");
}

function summary(pkg: ResearchPackage, name: string): string {
  const ratio = pkg.ratios;
  const lines = ["## 执行摘要", `${name} 本次研究覆盖 ${pkg.stock.canonical}。`];
  if (ratio) {
    lines.push(`最近报告期 ${ratio.reportDate}（${ratio.reportType}，${ratio.profitBasis}）的资产负债率为 ${formatPercent(ratio.debtToAsset)}，毛利率 ${formatPercent(ratio.grossMargin)}，净利率 ${formatPercent(ratio.netMargin)}。${cite(ratio.evidenceIds)}`);
  } else {
    lines.push("结构化财务比率缺少可计算的数据，执行摘要不给出盈利或杠杆结论。");
  }
  const yearly = pkg.drawdowns.find((item) => item.period === "year");
  lines.push(yearly?.result
    ? `近一年最大回撤为 ${formatPercent(yearly.result.rate)}，峰值 ${yearly.result.peakDate}，谷值 ${yearly.result.troughDate}。${cite(yearly.evidenceId ? [yearly.evidenceId] : [])}`
    : "近一年最大回撤因价格样本未覆盖完整年度而未计算。");
  lines.push(`证据充分度：${pkg.evidence.length} 条材料，${pkg.failures.length} 个来源失败。失败来源对应的章节只记录缺口，不补写事实。`);
  return lines.join("\n\n");
}

function introduction(pkg: ResearchPackage, name: string): string {
  const profile = pkg.profile;
  const profileCite = profile ? cite([profile.evidenceId]) : "";
  const ratio = pkg.ratios;
  const latest = pkg.financials.at(-1);
  const upstream = snippets(pkg, ["供应商", "上游", "原材料"]);
  const downstream = snippets(pkg, ["客户", "下游", "经销商", "集中度"]);
  return [
    "## 基本介绍",
    "### 公司介绍",
    profile?.introduction ? `${profile.introduction}${profileCite}` : `公开公司概况没有返回 ${name} 的简介。`,
    "### 公司规模",
    [
      profile?.employees !== null && profile?.employees !== undefined ? `员工人数：${formatNumber(profile.employees, 0)} 人。${profileCite}` : "员工人数：本次来源未披露。",
      profile?.registeredCapital ? `注册资本：${profile.registeredCapital}。${profileCite}` : "注册资本：本次来源未披露。",
      pkg.quote?.marketCap ? `总市值：${formatYi(pkg.quote.marketCap)}，对应行情时点的最新价 ${formatNumber(pkg.quote.price)} 元。${cite([pkg.quote.evidenceId])}` : "总市值：行情来源未返回。",
      profile?.industry ? `行业：${profile.industry}。${profileCite}` : "行业：未披露。",
    ].join("\n"),
    "### 公司业务",
    profile?.businessScope ? `${profile.businessScope}${profileCite}` : "营业范围未包含在本次结构化结果中。",
    "### 公司流水",
    "上市公司通常不公开银行流水。本报告不估算流水，只把营业收入、营业成本和经营活动现金流作为可复核的经营规模口径。",
    latest
      ? `经营活动现金流：${formatMaybeYi(latest.figures.operatingCashFlow)}；营业成本：${formatMaybeYi(latest.figures.costOfRevenue)}。${cite(latest.evidenceIds)}`
      : "现金流与成本没有可引用的报表数据。",
    "### 公司营收",
    latest && ratio
      ? `${ratio.reportDate} ${ratio.reportType}营业总收入 ${formatYi(latest.figures.revenue)}，归母净利润 ${formatYi(latest.figures.netIncome)}。收入同比 ${formatPercent(ratio.revenueYoY)}。利润口径为${ratio.profitBasis}。${cite(ratio.evidenceIds)}`
      : "营业收入没有可引用的报表数据。",
    "### 上下游关系",
    upstream.length > 0 ? upstream.map((item) => `- 供应相关材料：${item.summary}${cite([item.id])}`).join("\n") : "本次材料没有披露具名供应商。系统不会用行业常识补写供应关系。",
    downstream.length > 0 ? downstream.map((item) => `- 需求相关材料：${item.summary}${cite([item.id])}`).join("\n") : "本次材料没有披露具名客户或经销商。系统不会把渠道常识写成公司事实。",
    "### 资产与负债",
    latest
      ? `总资产 ${formatYi(latest.figures.totalAssets)}，总负债 ${formatYi(latest.figures.totalLiabilities)}，归母权益 ${formatMaybeYi(latest.figures.equity)}。资产负债率 ${formatPercent(ratio?.debtToAsset ?? null)}，流动比率 ${formatNumber(ratio?.currentRatio ?? null)}，速动比率 ${formatNumber(ratio?.quickRatio ?? null)}。${cite(latest.evidenceIds)}`
      : "资产与负债没有可引用的报表数据。",
  ].join("\n\n");
}

function news(pkg: ResearchPackage): string {
  const articles = pkg.evidence.filter((item) => item.category === "新闻");
  const filings = pkg.evidence.filter((item) => item.source === "巨潮资讯");
  return [
    "## 新闻报道",
    "### 正面新闻",
    renderEvidence(articles.filter((item) => item.sentiment === "positive"), "没有检索到命中正面关键词的新闻。"),
    "### 负面新闻",
    renderEvidence(articles.filter((item) => item.sentiment === "negative"), "没有检索到命中负面关键词的新闻。关键词分类只用于检索，正文仍需人工阅读。"),
    "### 公司股东",
    pkg.holders.length > 0
      ? pkg.holders.map((holder) => `- ${holder.reportDate} ${holder.name}：持股 ${formatNumber(holder.shares, 0)} 股，占总股本比例 ${formatNumber(holder.ratioPercent)}%。${cite([holder.evidenceId])}`).join("\n")
      : "十大流通股东数据未取得。",
    "### 经营情况报道",
    renderEvidence([...filings, ...articles.filter((item) => item.sentiment === "neutral")].slice(0, 12), "没有取得公告或中性经营报道。"),
  ].join("\n\n");
}

function risks(pkg: ResearchPackage): string {
  const ratio = pkg.ratios;
  return [
    "## 风险分析",
    "### 负债和资产比",
    ratio
      ? `总负债 / 总资产 = ${formatPercent(ratio.debtToAsset)}。流动比率 ${formatNumber(ratio.currentRatio)}，速动比率 ${formatNumber(ratio.quickRatio)}，利息保障倍数 ${formatNumber(ratio.interestCoverage)}。利息保障倍数在利息费用缺失或非正数时不计算。${cite(ratio.evidenceIds)}`
      : "负债和资产比缺少可比分母或分子，未计算。",
    "### 股票走势",
    pkg.trend.lastClose !== null
      ? `截至 ${pkg.trend.lastDate} 的前复权收盘价为 ${formatNumber(pkg.trend.lastClose)} 元。20 日均线 ${formatNumber(pkg.trend.ma20)} 元，60 日均线 ${formatNumber(pkg.trend.ma60)} 元，样本年化波动率 ${formatPercent(pkg.trend.annualizedVolatility)}。${cite(pkg.trend.evidenceId ? [pkg.trend.evidenceId] : [])}`
      : "没有足够的行情序列描述股票走势。",
    pkg.quote ? `市盈率 ${formatNumber(pkg.quote.pe)}，市净率 ${formatNumber(pkg.quote.pb)}。估值使用行情接口当时的公开口径。${cite([pkg.quote.evidenceId])}` : "估值倍数未取得。",
    "### 经营情况风险",
    ratio
      ? `毛利率 ${formatPercent(ratio.grossMargin)}，净利率 ${formatPercent(ratio.netMargin)}，ROE ${formatPercent(ratio.returnOnEquity)}，ROA ${formatPercent(ratio.returnOnAssets)}，经营现金流 / 归母净利润 ${formatNumber(ratio.cashToProfit)}。${ratio.profitBasis === "累计未年化" ? "ROE 与 ROA 使用累计利润，未年化。" : "年报口径下利润覆盖完整会计年度。"}经营风险还需结合负面报道和公告，不能只凭一个比率判断。${cite(ratio.evidenceIds)}`
      : "经营比率缺少数据。",
    "### 董事会人员风险",
    board(pkg),
    "### 经验风险",
    pkg.prices.length > 0
      ? `可观察价格样本从 ${pkg.prices[0]?.date} 到 ${pkg.prices.at(-1)?.date}，共 ${pkg.prices.length} 个交易日。样本起点受本次抓取窗口限制，不代表上市以来的全部经营经验。${cite(pkg.trend.evidenceId ? [pkg.trend.evidenceId] : [])}`
      : "没有价格样本可用于描述历史经验。",
    "### 最大回撤",
    "最大回撤 = 区间内谷值收盘价 / 区间内此前峰值收盘价 - 1。价格使用前复权收盘价。",
    ...pkg.drawdowns.map((item) => item.result
      ? `- ${item.label}：${formatPercent(item.result.rate)}，峰值 ${item.result.peak}（${item.result.peakDate}），谷值 ${item.result.trough}（${item.result.troughDate}），窗口起点 ${item.start}。${cite(item.evidenceId ? [item.evidenceId] : [])}`
      : `- ${item.label}：样本未覆盖从 ${item.start || "窗口起点"} 开始的完整区间，不计算。`),
    "### 政策影响",
    policy(pkg),
  ].join("\n\n");
}

function opinion(pkg: ResearchPackage): string {
  const comments = pkg.evidence.filter((item) => item.category === "网友评论");
  const media = pkg.evidence.filter((item) => item.category === "新闻" && item.sourceGrade === "B");
  return [
    "## 舆论",
    "### 网上评价",
    comments.length > 0
      ? `股吧样本 ${comments.length} 条，只代表抓取到的公开帖子，不代表全体投资者。\n${renderEvidence(comments.slice(0, 10), "")}`
      : "没有取得可解析的公开网友帖子。访问受限时系统停止，不绕过验证。",
    "### 网友认知",
    sentimentLine(comments, "网友帖子"),
    "### 网友看法",
    comments.length > 0 ? "以下看法保留发言者的原标题，系统不把个别帖子提升为事实：\n" + renderEvidence(comments.slice(0, 6), "") : "没有足够帖子归纳网友看法。",
    "### 知名报刊、公众号与媒体人点评",
    media.length > 0 ? renderEvidence(media, "") : "本次结果没有命中已登记的知名报刊来源。其他媒体报道列在新闻章节，不人为拔高来源级别。",
  ].join("\n\n");
}

function riskMatrix(pkg: ResearchPackage): string {
  const header = "| 风险 | 影响（1-3） | 证据强度（1-3） | 依据 | 证据 |\n| --- | --- | --- | --- | --- |";
  const rows = pkg.risks.map((risk) => `| ${risk.name} | ${risk.impact ?? "不评级"} | ${risk.probability ?? "不外推"} | ${risk.rationale.replaceAll("|", "/")} | ${cite(risk.evidenceIds) || "无"} |`);
  return [header, ...rows, "", "影响等级是代码中的固定阈值，证据强度只反映材料数量和是否已经发生，二者都不是评级机构意见。"].join("\n");
}

function opinionDetail(pkg: ResearchPackage): string {
  const comments = pkg.evidence.filter((item) => item.category === "网友评论");
  const media = pkg.evidence.filter((item) => item.category === "新闻");
  return [
    sentimentLine(comments, "网友样本"),
    sentimentLine(media, "媒体样本"),
    "样本偏差：搜索排序、媒体转载和股吧活跃用户都会放大极端观点。D 级网友评论不能单独支持重大风险结论。",
    media.length > 0 ? renderEvidence(media.slice(0, 8), "") : "没有媒体样本。",
  ].join("\n\n");
}

function scenarios(pkg: ResearchPackage): string {
  return [
    "## 情景与数据局限",
    "### 基准情景",
    "维持最近一个报告期已披露的业务范围和资本结构，不外推未披露订单。",
    "### 乐观情景",
    "只有在后续定期报告同时显示收入、经营现金流和负债率改善时，才提高对经营质量的判断。",
    "### 悲观情景",
    "若后续出现审计非标、债务集中到期、监管处罚或年度回撤继续扩大，应重新采集法定公告后再评估。",
    "三种情景都不给出目标股价、收益承诺或买卖建议。",
    `本次生成时点：${formatShanghai(pkg.generatedAt)}。`,
  ].join("\n\n");
}

function limitations(pkg: ResearchPackage): string {
  return [
    "## 数据局限与免责声明",
    "财务数字优先来自公开聚合接口中的资产负债表、利润表和现金流量表，证据级别为 C，不能替代巨潮资讯或交易所定期报告原文。",
    "最大回撤、均线和波动率由本地代码按前复权收盘价计算，公式见风险章节。",
    pkg.failures.length > 0 ? `未能完成的来源：${pkg.failures.map((item) => `${item.source}（${item.message}）`).join("；")}。` : "本次计划内来源均返回了可解析结果。",
    "本报告仅供研究学习，不是投资建议、邀约或收益承诺。使用者应独立核对原始公告并自行承担决策责任。",
  ].join("\n\n");
}

function bibliography(evidence: EvidenceRecord[]): string {
  const lines = evidence.map((item) => `- [${item.id}] ${item.sourceGrade} 级｜${item.source}｜${item.title}｜${item.publishedAt ?? "无发布日期"}｜${item.url ?? item.locator ?? "无链接"}`);
  return ["## 引用清单", lines.length > 0 ? lines.join("\n") : "没有可列出的证据。"].join("\n\n");
}

function board(pkg: ResearchPackage): string {
  const profile = pkg.profile;
  if (!profile) return "董事会和管理层信息未取得。";
  const citeText = cite([profile.evidenceId]);
  return [
    `董事长：${profile.chairman ?? "未披露"}。${citeText}`,
    `总经理：${profile.generalManager ?? "未披露"}。${citeText}`,
    `独立董事：${profile.independentDirectors ?? "未披露"}。${citeText}`,
    profile.generalManager?.includes("代") ? "总经理名称含“代”，报告将其标为任职状态风险线索，不推断个人过错。" : "本次概况没有显示总经理代理任职。",
  ].join("\n");
}

function policy(pkg: ResearchPackage): string {
  const hits = pkg.evidence.filter((item) => ["政策", "海关", "关税", "出口管制", "制裁", "地缘", "监管", "立案", "处罚"].some((word) => `${item.title}${item.summary}`.includes(word)));
  if (hits.length === 0) return "本次公告、新闻、百科和本地材料没有命中政策、海关、监管或地缘政治关键词。这只说明样本中没有直接证据，不能证明公司不受政策影响。";
  return hits.slice(0, 8).map((item) => `- ${item.title}：${item.summary}${cite([item.id])}`).join("\n");
}

function snippets(pkg: ResearchPackage, words: string[]): EvidenceRecord[] {
  return pkg.evidence.filter((item) => words.some((word) => `${item.title}${item.summary}`.includes(word))).slice(0, 5);
}

function renderEvidence(records: EvidenceRecord[], empty: string): string {
  if (records.length === 0) return empty;
  return records.map((item) => `- ${item.publishedAt ?? "日期未披露"}｜${item.publisher ?? item.source}｜${item.title}。${item.summary}${cite([item.id])}`).join("\n");
}

function sentimentLine(records: EvidenceRecord[], label: string): string {
  const positive = records.filter((item) => item.sentiment === "positive").length;
  const negative = records.filter((item) => item.sentiment === "negative").length;
  const neutral = records.filter((item) => item.sentiment === "neutral").length;
  return `${label}：正面 ${positive}，负面 ${negative}，中性或未命中关键词 ${neutral}。`;
}

function formatMaybeYi(value: number): string {
  return Number.isFinite(value) ? formatYi(value) : "数据不足";
}
