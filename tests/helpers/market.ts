import type { SafeClient } from "../../src/server/sources/http";

export function marketClient(overrides: Partial<Record<"get" | "post", (url: string) => string | Promise<string>>> = {}): SafeClient {
  return {
    async get(url) {
      const body = overrides.get ? await overrides.get(url) : bodyFor(url);
      return { url, status: 200, body: Buffer.from(body), contentType: url.includes("baike") || url.includes("example.com") ? "text/html" : "application/json" };
    },
    async post(url) {
      const body = overrides.post ? await overrides.post(url) : announcements();
      return { url, status: 200, body: Buffer.from(body), contentType: "application/json" };
    },
  };
}

function bodyFor(url: string): string {
  if (url.includes("/api/qt/stock/get")) return JSON.stringify({ data: { f43: 20000, f57: "600519", f58: "贵州茅台", f59: 2, f60: 19000, f116: 100_000_000_000, f127: "白酒", f162: 1500, f167: 200 } });
  if (url.includes("/kline/get")) return JSON.stringify({ data: { code: "600519", klines: klines() } });
  if (url.includes("GBALANCE")) return JSON.stringify({ result: { data: [balance("2024-12-31", 180, 90), balance("2025-12-31", 200, 80)] } });
  if (url.includes("GINCOME")) return JSON.stringify({ result: { data: [income("2024-12-31", 200), income("2025-12-31", 250)] } });
  if (url.includes("GCASHFLOW")) return JSON.stringify({ result: { data: [cash("2024-12-31"), cash("2025-12-31")] } });
  if (url.includes("CompanySurvey")) return JSON.stringify({ jbzl: { agdm: "600519", gsmc: "贵州茅台酒股份有限公司", gsjj: "公司生产并销售茅台酒。", jyfw: "茅台酒及系列酒的生产与销售。", gyrs: 1000, zczb: "12.50亿", gswz: "https://example.com", sshy: "酿酒行业", qy: "贵州", dsz: "陈华", zjl: "王莉(代)", dlds: "郭田勇" } });
  if (url.includes("FREEHOLDERS")) return JSON.stringify({ result: { data: [{ HOLDER_NAME: "茅台集团", HOLD_NUM: 100, HOLD_RATIO: 54.5, END_DATE: "2025-12-31 00:00:00", HOLDER_TYPE: "国有法人" }] } });
  if (url.includes("szse_stock.json")) return JSON.stringify({ stockList: [{ code: "600519", orgId: "gssh0600519", category: "A股" }] });
  if (url.includes("search/jsonp")) return `cb(${JSON.stringify({ result: { cmsArticleWebOld: [{ title: "贵州茅台收入增长", content: "收入增长", mediaName: "北京商报", date: "2026-11-01", url: "https://finance.example.com/a" }, { title: "贵州茅台收到监管处罚", content: "公司收到监管处罚", mediaName: "自媒体", date: "2026-11-02", url: "https://finance.example.com/b" }] } })})`;
  if (url.includes("Articlelist")) return JSON.stringify({ re: [{ post_id: 1, post_title: "看好茅台长期", stockbar_code: "600519", user_nickname: "网友甲", post_publish_time: "2026-11-03 10:00:00" }] });
  if (url.includes("baike.baidu.com")) return `<html><meta name="description" content="贵州茅台酒股份有限公司是白酒生产企业。"><title>贵州茅台</title></html>`;
  if (url.includes("example.com")) return `<html><title>贵州茅台官网</title><meta name="description" content="公司官方网站介绍茅台酒业务。"></html>`;
  throw new Error(`测试夹具未覆盖 ${url}`);
}

function announcements(): string {
  return JSON.stringify({ announcements: [
    { secCode: "000001", orgId: "gssz0000001", announcementTitle: "其他公司公告", announcementTime: 1760000000000, adjunctUrl: "other.pdf", announcementType: null, announcementTypeName: null },
    { secCode: "600519", orgId: "gssh0600519", announcementTitle: "2025年年度报告", announcementTime: 1764547200000, adjunctUrl: "finalpage/2026/a.PDF", announcementType: "01010503||010113", announcementTypeName: null },
  ] });
}

function balance(date: string, assets: number, liabilities: number): Record<string, unknown> {
  return { REPORT_DATE: `${date} 00:00:00`, REPORT_TYPE: "年报", TOTAL_ASSETS: assets, TOTAL_LIABILITIES: liabilities, TOTAL_CURRENT_ASSETS: 100, INVENTORY: 20, TOTAL_CURRENT_LIAB: 50, TOTAL_PARENT_EQUITY: assets - liabilities };
}

function income(date: string, revenue: number): Record<string, unknown> {
  return { REPORT_DATE: `${date} 00:00:00`, REPORT_TYPE: "年报", TOTAL_OPERATE_INCOME: revenue, OPERATE_COST: 150, OPERATE_PROFIT: 40, PARENT_NETPROFIT: 25, INTEREST_EXPENSE: 10 };
}

function cash(date: string): Record<string, unknown> {
  return { REPORT_DATE: `${date} 00:00:00`, REPORT_TYPE: "年报", NETCASH_OPERATE: 30 };
}

function klines(): string[] {
  const lines: string[] = [];
  const start = Date.UTC(2025, 0, 1);
  for (let index = 0; index < 680; index += 1) {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const close = date === "2026-09-01" ? 200 : 100;
    lines.push(`${date},100,${close},100,100,1,1,1,1,1,1`);
  }
  return lines;
}
