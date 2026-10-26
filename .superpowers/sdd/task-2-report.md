# Task 2 实施报告

## 状态

DONE

## 修改摘要

- 新增受限 JSON HTTP 客户端：仅允许 HTTPS、443 端口和显式主机白名单；拒绝凭据、私网/回环地址及重定向；单次超时不超过 12 秒、最多重试两次，并限制请求体和响应体。
- 新增东方财富公司概况、历史行情和财务数据适配器；对价格、日期及财务字段做显式规范化，缺失财务字段时丢弃不完整快照而不填造数值。
- 新增巨潮资讯公告适配器，保留公告链接、发布日期、分类、A级来源等级、内容哈希和检索时间。
- 新增 `EvidenceStore`，按内容哈希去重并保留更强来源，强度顺序为 A > B > C > D；所有证据均有明确检索时间。
- 新增本地文档解析：支持 PDF、XLSX、Markdown、TXT、CSV、HTML；限制文件为普通文件且不超过 10 MiB，校验扩展名、签名/UTF-8，并限制 PDF 页数、XLSX 解压大小/工作表/行数和提取文本大小；保留页码、工作表或行号定位。
- 新增研究包编排：以 `Promise.allSettled` 独立运行来源，记录逐来源失败；计算最新财务比率及周/月/季/年回撤，正确处理月末窗口；缺失数据保持 `null` 或空数组。
- 增补共享类型、确定性 fixture/mock 测试和依赖：`pdfjs-dist@6.4.299`、`read-excel-file@9.3.12`、测试辅助 `fflate@0.8.3`。
- 新增根 `.gitignore`，排除 `node_modules/` 与 `dist/`。

## Commits

- `6a99d45 test: define public research pipeline behavior`
- `29069c5 feat: add public research data pipeline`
- `2f23a61 fix: support current XLSX parser API`
- `dcad0d9 fix: release PDF loading resources`
- `375f3a4 fix: align pipeline with project runtime types`
- `23134f6 test: cover permanent fetch errors and month-end windows`
- `c63688e fix: bound retries and clamp calendar windows`
- `4e02b4a chore: ignore generated dependency artifacts`

以上提交均已推送至 `origin/cursor/task-2-research-pipeline-9363`。

## TDD 与测试命令的真实输出

### 初始 RED：模块尚未实现

命令：

```bash
npm test -- --run tests/evidence.test.ts tests/research.test.ts
```

真实输出（exit code 1）：

```text
> a-stock-fundamental-agent@0.1.0 test
> vitest --run tests/evidence.test.ts tests/research.test.ts

 RUN  v5.0.5 /workspace

 ❯ tests/research.test.ts (0 test)
 ❯ tests/evidence.test.ts (0 test)

 Failed Suites 2

 FAIL  tests/evidence.test.ts [ tests/evidence.test.ts ]
Error: Cannot find module '../src/server/documents/parser' imported from /workspace/tests/evidence.test.ts

 FAIL  tests/research.test.ts [ tests/research.test.ts ]
Error: Cannot find module '../src/server/research/build-research' imported from /workspace/tests/research.test.ts

 Test Files  2 failed (2)
      Tests  no tests
```

### 边界回归 RED

命令：

```bash
npm test -- --run tests/evidence.test.ts tests/research.test.ts
```

真实输出（exit code 1）：

```text
 RUN  v5.0.5 /workspace

 ❯ tests/research.test.ts (3 tests | 1 failed)
   × clamps calendar-month windows at month end
 ❯ tests/evidence.test.ts (9 tests | 1 failed)
   × caps retries at two and rejects oversized responses

AssertionError: expected "vi.fn()" to be called 1 times, but got 3 times
AssertionError: expected +0 to be close to -0.25

 Test Files  2 failed (2)
      Tests  2 failed | 10 passed (12)
```

### 最终聚焦测试

命令：

```bash
npm test -- --run tests/evidence.test.ts tests/research.test.ts
```

真实输出（exit code 0）：

```text
> a-stock-fundamental-agent@0.1.0 test
> vitest --run tests/evidence.test.ts tests/research.test.ts

 RUN  v5.0.5 /workspace

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  14:48:44
   Duration  412ms (tests 45%, import 39%, transform 13%, worker 3%)
```

### 全量测试

命令：

```bash
npm test -- --run
```

真实输出（exit code 0）：

```text
> a-stock-fundamental-agent@0.1.0 test
> vitest --run

 RUN  v5.0.5 /workspace

 Test Files  4 passed (4)
      Tests  23 passed (23)
   Start at  14:48:44
   Duration  410ms (tests 46%, import 38%, transform 12%, worker 3%)
```

### TypeScript 自检

命令：

```bash
npm run typecheck
```

真实输出（exit code 0）：

```text
> a-stock-fundamental-agent@0.1.0 typecheck
> tsc --noEmit
```

### 依赖安全自检

命令：

```bash
npm audit --audit-level=high
```

真实输出（exit code 0）：

```text
found 0 vulnerabilities
```

### 构建自检

命令：

```bash
npm run build
```

真实输出（exit code 1）：

```text
> a-stock-fundamental-agent@0.1.0 build
> vite build

vite v8.3.5 building client environment for production...
transforming...
✓ 1 modules transformed.
✗ Build failed in 17ms
error during build:
Build failed with 1 error:

[UNRESOLVED_ENTRY] Cannot resolve entry module index.html.
```

## Concerns

- 当前仓库沿用任务 1 的 Vite 客户端构建脚本，但尚无 `index.html`，因此 `npm run build` 在进入本任务服务端代码打包前即失败；本任务要求的聚焦/全量测试、类型检查和依赖审计均通过。未在任务 2 范围内伪造客户端入口。
- 公开数据接口的上游字段可能变化。适配器遇到缺失、异常字段或不可拼接报告期时会抛出来源错误，由研究编排记录失败，不会用零值、空成功或推测值替代；生产运行应关注这些降级记录。

---

## 审查修复：真实来源契约、证据链与本地访问控制

### 状态

DONE

### 修改摘要

- 使用线上公开接口核验并提交脱敏真实结构快照：
  - 东方财富 `RPT_F10_FINANCE_GBALANCE`、`RPT_F10_FINANCE_GINCOME`、`RPT_F10_FINANCE_GCASHFLOW`。
  - 巨潮资讯 `topSearch/query` 组织查询及 `hisAnnouncement/query` 公告查询。
- 财务适配器改为按 `SECUCODE + REPORT_DATE + REPORT_TYPE` 拼接资产负债表、利润表和现金流量表；分别使用总资产、总负债、流动资产、存货、流动负债、归母权益、营业总收入、营业成本、归母净利润、经营现金流和财务费用利息字段。EBIT 口径明确为 `TOTAL_PROFIT + FE_INTEREST_EXPENSE`。
- 财务响应缺失记录、字段契约变化、股票不匹配、必需字段不可用或报告期无法拼接时抛出来源错误，不再静默返回空成功；快照按 `reportDate` 降序。
- 巨潮适配器先用严格股票代码获取 `orgId`，再以 `code,orgId` 查询；结果同时过滤 `secCode` 并在存在时核对 `orgId`。分类依次使用 `announcementTypeName`、`announcementType`、`columnId`、`pageColumn`。
- 新增 `assertStockId`，所有生产适配器及研究编排复用任务 1 的 A 股号段、交易所和 canonical 一致性校验。
- 公司概况、行情和每个财务报告期生成 `EvidenceRecord`；研究包的比率与回撤包含证据 ID、检索时间、报告期/窗口、口径及是否年化。中报、季报标记为累计期且 `annualized: false`。
- 回撤仅在历史序列覆盖完整周/月/季/年起点时返回结果，否则返回 `null`。
- 同步来源异常通过延迟调用纳入 `Promise.allSettled`；本地文档继续并发处理。
- 本地解析必须配置知识库根目录，使用 `lstat + realpath + O_NOFOLLOW`，拒绝根目录外路径及任意路径组件中的符号链接。
- XLSX 在交给工作簿解析器前以流式解压计算实际输出字节，拒绝伪造 ZIP 元数据的压缩炸弹；`fflate` 调整为运行时依赖。
- PDF 显式传入禁用 eval、字体和 WASM 的安全选项，并以最大 12 秒超时销毁加载任务。
- HTML 实体使用单次映射解码，提取结果标记为 `text/plain`。
- HTTP 对 429/503 和网络错误实施 250ms 起始的指数退避，尊重并限制 `Retry-After`，保留原 HTTPS、443、主机白名单、私网拒绝、重定向拒绝及响应大小限制。

### Commits

- `fd5b504 test: capture real source contracts and review regressions`
- `8101ae7 fix: use verified public source contracts`
- `3920f2e test: align assertions with source timestamp semantics`
- `736b283 fix: confine and bound local document parsing`
- `71e1ef3 fix: govern research evidence and period coverage`
- `6e8c7b9 style: normalize source file ending`

以上提交均已推送至 `origin/cursor/task-2-research-pipeline-9363`。

### 审查回归 RED

命令：

```bash
npm test -- --run tests/evidence.test.ts tests/research.test.ts tests/stock-id.test.ts
```

真实输出摘要（exit code 1）：

```text
RUN  v5.0.5 /workspace

Test Files  3 failed (3)
     Tests  16 failed | 14 passed (30)

主要失败：
- expected financial snapshots length 4, received 0
- expected changed financial contract to reject, promise resolved []
- expected CNInfo records length 3, received 5
- expected Retry-After delays [[2000], [500]], received []
- synchronous quote failure escaped buildResearchPackage
- incomplete history returned drawdowns instead of null
- invalid ETF StockId resolved instead of rejecting
- assertStockId is not a function
```

### 最终任务 2 聚焦测试

命令：

```bash
npm test -- --run tests/evidence.test.ts tests/research.test.ts
```

真实输出（exit code 0）：

```text
> a-stock-fundamental-agent@0.1.0 test
> vitest --run tests/evidence.test.ts tests/research.test.ts

 RUN  v5.0.5 /workspace

 Test Files  2 passed (2)
      Tests  23 passed (23)
   Start at  15:08:03
   Duration  2.10s (tests 88%, import 7%, transform 4%)
```

### 最终全量测试

命令：

```bash
npm test -- --run
```

真实输出（exit code 0）：

```text
> a-stock-fundamental-agent@0.1.0 test
> vitest --run

 RUN  v5.0.5 /workspace

 Test Files  4 passed (4)
      Tests  35 passed (35)
   Start at  15:08:03
   Duration  2.01s (tests 91%, import 7%, transform 2%, worker 1%)
```

### 最终 TypeScript 自检

命令：

```bash
npm run typecheck
```

真实输出（exit code 0）：

```text
> a-stock-fundamental-agent@0.1.0 typecheck
> tsc --noEmit
```

### 最终依赖审计

命令：

```bash
npm audit --audit-level=high
```

真实输出（exit code 0）：

```text
found 0 vulnerabilities
```

### 审查修复 Concerns

- 线上数据源仍可能调整公开字段或临时限流；当前行为是带退避重试后抛出明确来源错误，并由研究包记录，不会把契约变化伪装成空成功。
- 仓库原有 `npm run build` 仍因缺少客户端 `index.html` 失败；该问题与任务 2 服务端实现无关，聚焦/全量测试、类型检查与依赖审计均通过。
