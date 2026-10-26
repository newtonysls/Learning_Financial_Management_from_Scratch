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
- 公开数据接口的上游字段可能变化。适配器遇到缺失或异常字段时会返回空结果或记录来源失败，不会用零值或推测值替代；生产运行应关注这些降级记录。
