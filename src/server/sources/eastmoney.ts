import type { EvidenceStore } from "../evidence/evidence-store";
import type {
  CompanyProfile,
  EvidenceDraft,
  HolderPosition,
  PricePoint,
  QuoteSnapshot,
  ReportedFinancials,
  StockId,
} from "../../shared/types";
import { classifySentiment, excerpt, finiteNumber, sha256 } from "../analysis/text";
import { addDays, civilDate, compareCivil } from "../analysis/dates";
import { shanghaiDate } from "../analysis/text";
import type { SafeClient } from "./http";
import { http } from "./http";

const KNOWN_MEDIA = ["北京商报", "证券时报", "中国证券报", "上海证券报", "证券日报", "新华社", "人民日报", "经济日报", "第一财经", "21世纪经济报道", "财新", "澎湃", "界面新闻", "每日经济新闻", "中国基金报", "经济观察报"];

export interface MarketContext {
  client?: SafeClient;
  store: EvidenceStore;
  retrievedAt: string;
}

export async function fetchQuote(stock: StockId, context: MarketContext): Promise<QuoteSnapshot> {
  const secid = securityId(stock);
  const hosts = ["push2delay.eastmoney.com", "push2.eastmoney.com"];
  let payload: Record<string, unknown> | null = null;
  let url = "";
  let lastError: Error | undefined;
  for (const host of hosts) {
    url = `https://${host}/api/qt/stock/get?secid=${secid}&fields=f43,f57,f58,f59,f60,f116,f127,f162,f167`;
    try {
      payload = await readJson(context, url, "东方财富行情", undefined, 1);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("东方财富行情请求失败");
    }
  }
  if (!payload) throw lastError ?? new Error("东方财富行情请求失败");
  const data = record(payload.data, "东方财富行情缺少 data");
  const scale = 10 ** (finiteNumber(data.f59) ?? 2);
  const price = scalePrice(data.f43, scale);
  const previousClose = scalePrice(data.f60, scale);
  if (String(data.f57 ?? "") !== stock.code || price === null || previousClose === null) {
    throw new Error("东方财富行情字段与股票代码不匹配");
  }
  const evidence = context.store.add(draft(context, {
    source: "东方财富行情",
    sourceGrade: "C",
    title: `${text(data.f58) || stock.code} 最新行情`,
    url,
    publisher: "东方财富",
    summary: `最新价 ${price} 元，前收盘 ${previousClose} 元。价格按接口小数位 f59 缩放。`,
    category: "行情",
  }));
  return {
    name: text(data.f58) || stock.canonical,
    price,
    previousClose,
    marketCap: finiteNumber(data.f116),
    pe: scalePrice(data.f162, 100),
    pb: scalePrice(data.f167, 100),
    industry: text(data.f127) || null,
    evidenceId: evidence.id,
  };
}

export async function fetchPriceHistory(stock: StockId, context: MarketContext): Promise<{ points: PricePoint[]; evidenceId: string }> {
  const end = shanghaiDate(new Date(context.retrievedAt)).replaceAll("-", "");
  const begin = addDays(shanghaiDate(new Date(context.retrievedAt)), -460).replaceAll("-", "");
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${securityId(stock)}&klt=101&fqt=1&beg=${begin}&end=${end}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  const payload = await readJson(context, url, "东方财富日线");
  const data = record(payload.data, "东方财富日线缺少 data");
  if (String(data.code ?? "") !== stock.code) throw new Error("东方财富日线代码不匹配");
  const lines = Array.isArray(data.klines) ? data.klines : [];
  const points = new Map<string, PricePoint>();
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const [date, , close] = line.split(",");
    const price = finiteNumber(close);
    if (!date || price === null || price <= 0) continue;
    points.set(civilDate(date), { date: civilDate(date), close: price });
  }
  const asOf = shanghaiDate(new Date(context.retrievedAt));
  const series = [...points.values()]
    .filter((point) => compareCivil(point.date, asOf) <= 0)
    .sort((left, right) => compareCivil(left.date, right.date));
  if (series.length < 2) throw new Error("东方财富日线没有足够的有效收盘价");
  const evidence = context.store.add(draft(context, {
    source: "东方财富日线",
    sourceGrade: "C",
    title: `${stock.canonical} 前复权日线`,
    url,
    publisher: "东方财富",
    summary: `共 ${series.length} 个交易日，区间 ${series[0]?.date} 至 ${series.at(-1)?.date}，口径为前复权收盘价。`,
    category: "行情",
  }));
  return { points: series, evidenceId: evidence.id };
}

export async function fetchFinancials(stock: StockId, context: MarketContext): Promise<ReportedFinancials[]> {
  const filter = encodeURIComponent(`(SECUCODE="${stock.canonical}")`);
  const balanceUrl = statementUrl("RPT_F10_FINANCE_GBALANCE", "REPORT_DATE,REPORT_TYPE,TOTAL_ASSETS,TOTAL_LIABILITIES,TOTAL_CURRENT_ASSETS,INVENTORY,TOTAL_CURRENT_LIAB,TOTAL_PARENT_EQUITY", filter);
  const incomeUrl = statementUrl("RPT_F10_FINANCE_GINCOME", "REPORT_DATE,REPORT_TYPE,TOTAL_OPERATE_INCOME,OPERATE_COST,OPERATE_PROFIT,PARENT_NETPROFIT,INTEREST_EXPENSE", filter);
  const cashUrl = statementUrl("RPT_F10_FINANCE_GCASHFLOW", "REPORT_DATE,REPORT_TYPE,NETCASH_OPERATE", filter);
  const [balance, income, cash] = await Promise.all([
    readJson(context, balanceUrl, "东方财富资产负债表"),
    readJson(context, incomeUrl, "东方财富利润表"),
    readJson(context, cashUrl, "东方财富现金流量表"),
  ]);
  const balanceRows = rowsOf(balance, "资产负债表");
  const incomeRows = rowsOf(income, "利润表");
  const cashRows = rowsOf(cash, "现金流量表");
  const balanceEvidence = context.store.add(draft(context, statementEvidence("资产负债表", balanceUrl, balanceRows.length)));
  const incomeEvidence = context.store.add(draft(context, statementEvidence("利润表", incomeUrl, incomeRows.length)));
  const cashEvidence = context.store.add(draft(context, statementEvidence("现金流量表", cashUrl, cashRows.length)));
  const incomeByDate = new Map(incomeRows.map((row) => [civilDate(text(row.REPORT_DATE)), row]));
  const cashByDate = new Map(cashRows.map((row) => [civilDate(text(row.REPORT_DATE)), row]));
  const snapshots: ReportedFinancials[] = [];
  for (const row of balanceRows) {
    const reportDate = civilDate(text(row.REPORT_DATE));
    const incomeRow = incomeByDate.get(reportDate);
    const cashRow = cashByDate.get(reportDate);
    const totalAssets = finiteNumber(row.TOTAL_ASSETS);
    const totalLiabilities = finiteNumber(row.TOTAL_LIABILITIES);
    const revenue = finiteNumber(incomeRow?.TOTAL_OPERATE_INCOME);
    const netIncome = finiteNumber(incomeRow?.PARENT_NETPROFIT);
    const equity = finiteNumber(row.TOTAL_PARENT_EQUITY);
    if (!incomeRow || totalAssets === null || totalLiabilities === null || revenue === null || netIncome === null || equity === null) continue;
    const reportType = text(row.REPORT_TYPE) || text(incomeRow.REPORT_TYPE) || "未披露";
    snapshots.push({
      reportDate,
      reportType,
      profitBasis: reportType.includes("年报") ? "年度" : "累计未年化",
      figures: {
        totalAssets,
        totalLiabilities,
        currentAssets: finiteNumber(row.TOTAL_CURRENT_ASSETS) ?? Number.NaN,
        inventory: finiteNumber(row.INVENTORY) ?? Number.NaN,
        currentLiabilities: finiteNumber(row.TOTAL_CURRENT_LIAB) ?? Number.NaN,
        revenue,
        costOfRevenue: finiteNumber(incomeRow.OPERATE_COST) ?? Number.NaN,
        netIncome,
        operatingCashFlow: finiteNumber(cashRow?.NETCASH_OPERATE) ?? Number.NaN,
        equity,
        interestExpense: finiteNumber(incomeRow.INTEREST_EXPENSE) ?? Number.NaN,
        earningsBeforeInterestAndTax: finiteNumber(incomeRow.OPERATE_PROFIT) ?? Number.NaN,
      },
      evidenceIds: [balanceEvidence.id, incomeEvidence.id, cashEvidence.id],
      notes: [
        "净利润取归母净利润，净资产取归母权益。",
        "EBIT 使用营业利润作为公开接口中的可复核代理。",
        reportType.includes("年报") ? "年报利润为完整会计年度。" : "季报或中报利润为年初至报告期累计数，比率未做年化。",
      ],
    });
  }
  if (snapshots.length === 0) throw new Error("财务接口没有可计算的报表字段");
  snapshots.sort((left, right) => compareCivil(right.reportDate, left.reportDate));
  return snapshots;
}

export async function fetchProfile(stock: StockId, context: MarketContext): Promise<CompanyProfile> {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${stock.exchange}${stock.code}`;
  const payload = await readJson(context, url, "东方财富公司概况");
  const profile = record(payload.jbzl, "公司概况缺少 jbzl");
  if (text(profile.agdm) && text(profile.agdm) !== stock.code) throw new Error("公司概况代码不匹配");
  const evidence = context.store.add(draft(context, {
    source: "东方财富公司概况",
    sourceGrade: "C",
    title: `${text(profile.gsmc) || stock.canonical} 公司概况`,
    url,
    publisher: "东方财富",
    summary: excerpt(text(profile.gsjj) || text(profile.jyfw) || "公司概况未提供简介"),
    category: "公司概况",
  }));
  return {
    name: text(profile.gsmc) || stock.canonical,
    shortName: cleanName(profile.agjc),
    industry: text(profile.sshy) || null,
    region: text(profile.qy) || null,
    website: normalizeWebsite(text(profile.gswz)),
    introduction: text(profile.gsjj) || null,
    businessScope: text(profile.jyfw) || null,
    employees: finiteNumber(profile.gyrs),
    registeredCapital: text(profile.zczb) || null,
    chairman: cleanName(profile.dsz),
    generalManager: cleanName(profile.zjl),
    independentDirectors: cleanName(profile.dlds),
    evidenceId: evidence.id,
  };
}

export async function fetchHolders(stock: StockId, context: MarketContext): Promise<HolderPosition[]> {
  const filter = encodeURIComponent(`(SECUCODE="${stock.canonical}")`);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_EH_FREEHOLDERS&columns=HOLDER_NAME,HOLD_NUM,HOLD_RATIO,END_DATE,HOLDER_TYPE&filter=${filter}&pageNumber=1&pageSize=40&sortTypes=-1,-1&sortColumns=END_DATE,HOLD_RATIO`;
  const payload = await readJson(context, url, "东方财富股东数据");
  const rows = rowsOf(payload, "股东");
  const latest = civilDate(text(rows[0]?.END_DATE));
  const selected = rows.filter((row) => text(row.END_DATE) && civilDate(text(row.END_DATE)) === latest).slice(0, 10);
  if (selected.length === 0) throw new Error("股东接口没有最新报告期数据");
  const evidence = context.store.add(draft(context, {
    source: "东方财富十大流通股东",
    sourceGrade: "C",
    title: `${stock.canonical} ${latest} 十大流通股东`,
    url,
    publisher: "东方财富",
    reportPeriod: latest,
    summary: selected.map((row) => `${text(row.HOLDER_NAME)} ${finiteNumber(row.HOLD_RATIO) ?? "未披露"}%`).join("；"),
    category: "股东",
  }));
  return selected.map((row) => ({
    name: text(row.HOLDER_NAME) || "未披露名称",
    shares: finiteNumber(row.HOLD_NUM),
    ratioPercent: finiteNumber(row.HOLD_RATIO),
    holderType: text(row.HOLDER_TYPE) || null,
    reportDate: latest,
    evidenceId: evidence.id,
  }));
}

export async function fetchNews(keyword: string, stock: StockId, context: MarketContext): Promise<void> {
  const param = {
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "default", pageIndex: 1, pageSize: 15, preTag: "", postTag: "" } },
  };
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`;
  const response = await clientOf(context).get(url, { maxBytes: 2_000_000 });
  const json = response.body.toString("utf8").trim().replace(/^cb\(/, "").replace(/\);?$/, "");
  const payload = parseObject(json, "东方财富新闻");
  const articles = arrayRecord(record(payload.result, "新闻结果为空").cmsArticleWebOld);
  if (articles.length === 0) throw new Error("东方财富新闻没有返回文章");
  let kept = 0;
  for (const article of articles.slice(0, 15)) {
    const title = text(article.title);
    const summary = text(article.content);
    const combined = `${title} ${summary}`;
    const aliases = [keyword, stock.code, stock.canonical].filter((item) => item.length >= 2);
    if (!aliases.some((alias) => combined.includes(alias))) continue;
    const publisher = text(article.mediaName) || "未署名媒体";
    context.store.add(draft(context, {
      source: "东方财富新闻搜索",
      sourceGrade: KNOWN_MEDIA.some((media) => publisher.includes(media)) ? "B" : "C",
      title: title || "无标题新闻",
      url: text(article.url) || url,
      publisher,
      publishedAt: text(article.date) || null,
      summary: excerpt(summary || title),
      category: "新闻",
      sentiment: classifySentiment(combined),
    }));
    kept += 1;
  }
  if (kept === 0) throw new Error("东方财富新闻结果与该公司无法对应");
}

export async function fetchComments(stock: StockId, context: MarketContext): Promise<void> {
  const url = `https://gbapi.eastmoney.com/webarticlelist/api/Article/Articlelist?code=${stock.code}&ps=20&p=1&sorttype=1&deviceid=local-research&version=200&product=Guba&plat=Web`;
  const payload = await readJson(context, url, "东方财富股吧", { Referer: "https://guba.eastmoney.com/" });
  const posts = arrayRecord(payload.re).filter((post) => text(post.stockbar_code) === stock.code).slice(0, 20);
  if (posts.length === 0) throw new Error("股吧公开列表没有返回该公司帖子");
  for (const post of posts) {
    const title = text(post.post_title);
    context.store.add(draft(context, {
      source: "东方财富股吧",
      sourceGrade: "D",
      title: title || "无标题帖子",
      url: `https://guba.eastmoney.com/news,${stock.code},${text(post.post_id)}.html`,
      publisher: text(post.user_nickname) || "未署名网友",
      publishedAt: text(post.post_publish_time) || null,
      summary: excerpt(title),
      category: "网友评论",
      sentiment: classifySentiment(title),
    }));
  }
}

function statementUrl(reportName: string, columns: string, filter: string): string {
  return `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}&columns=${columns}&filter=${filter}&pageNumber=1&pageSize=12&sortTypes=-1&sortColumns=REPORT_DATE`;
}

function statementEvidence(name: string, url: string, count: number): Omit<EvidenceDraft, "retrievedAt"> {
  return {
    source: `东方财富${name}`,
    sourceGrade: "C",
    title: name,
    url,
    publisher: "东方财富数据中心",
    publishedAt: null,
    reportPeriod: null,
    summary: `读取最近报表 ${count} 期。该来源是公开聚合接口，使用前需与交易所定期报告核对。`,
    contentHash: "",
    locator: null,
    category: "财务报表",
    sentiment: null,
  };
}

function draft(context: MarketContext, input: Partial<EvidenceDraft> & Pick<EvidenceDraft, "source" | "sourceGrade" | "title" | "summary">): EvidenceDraft {
  return {
    url: null,
    publisher: null,
    publishedAt: null,
    reportPeriod: null,
    locator: null,
    category: null,
    sentiment: null,
    ...input,
    retrievedAt: context.retrievedAt,
    contentHash: input.contentHash || sha256(`${input.source}|${input.url ?? ""}|${input.title}|${input.summary}`),
  };
}

async function readJson(context: MarketContext, url: string, label: string, headers?: Record<string, string>, retries?: number): Promise<Record<string, unknown>> {
  const response = await clientOf(context).get(url, { headers, maxBytes: 3_000_000, retries });
  return parseObject(response.body.toString("utf8"), label);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown, `${label}不是 JSON 对象`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("不是 JSON")) throw error;
    throw new Error(`${label}返回了无法解析的内容`);
  }
}

function rowsOf(payload: Record<string, unknown>, label: string): Array<Record<string, unknown>> {
  const result = payload.result;
  if (!result || typeof result !== "object" || !Array.isArray((result as { data?: unknown }).data)) {
    throw new Error(`${label}响应缺少 data`);
  }
  return (result as { data: unknown[] }).data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function arrayRecord(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function scalePrice(value: unknown, scale: number): number | null {
  const number = finiteNumber(value);
  if (number === null || scale <= 0) return null;
  const scaled = number / scale;
  return scaled > 0 ? scaled : null;
}

function securityId(stock: StockId): string {
  return `${stock.exchange === "SH" ? 1 : 0}.${stock.code}`;
}

function normalizeWebsite(value: string): string | null {
  if (!value || value === "--") return null;
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    return url.protocol === "https:" ? `https://${url.hostname}` : null;
  } catch {
    return null;
  }
}

function cleanName(value: unknown): string | null {
  const name = text(value);
  return name && name !== "--" ? name : null;
}

function clientOf(context: MarketContext): SafeClient {
  return context.client ?? http;
}
