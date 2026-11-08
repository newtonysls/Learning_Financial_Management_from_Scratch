import { useEffect, useRef } from "react";
import type { ChartBundle } from "../../shared/types";

export function Charts({ charts }: { charts: ChartBundle }) {
  return (
    <section className="chart-grid">
      <Chart title="收入、利润与经营现金流" option={financialOption(charts)} />
      <Chart title="盈利能力与资产负债率" option={marginOption(charts)} />
      <Chart title="前复权收盘价" option={priceOption(charts)} />
      <Chart title="周、月、季、年最大回撤" option={drawdownOption(charts)} />
      <Chart title="负债与权益结构" option={capitalOption(charts)} />
      <Chart title="股东持股比例" option={holderOption(charts)} />
      <Chart title="新闻与评论情绪" option={sentimentOption(charts)} />
      <Chart title="规则化风险矩阵" option={riskOption(charts)} />
    </section>
  );
}

function Chart({ title, option }: { title: string; option: Record<string, unknown> | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !option) return undefined;
    let disposed = false;
    let chart: { dispose: () => void; resize: () => void } | undefined;
    void import("echarts").then((echarts) => {
      if (disposed || !ref.current) return;
      const instance = echarts.init(ref.current);
      instance.setOption(option);
      chart = instance;
    });
    const resize = () => chart?.resize();
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [option]);
  return (
    <article className="chart">
      <h3>{title}</h3>
      {option ? <div ref={ref} className="chart-canvas" /> : <p className="muted">这项图表缺少可绘制的数据。</p>}
    </article>
  );
}

function financialOption(charts: ChartBundle): Record<string, unknown> | null {
  if (charts.financials.periods.length === 0) return null;
  return {
    tooltip: { trigger: "axis" },
    legend: { data: ["营业总收入", "归母净利润", "经营现金流"] },
    xAxis: { type: "category", data: charts.financials.periods },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => `${(value / 100000000).toFixed(0)}亿` } },
    series: [
      { name: "营业总收入", type: "bar", data: charts.financials.revenue },
      { name: "归母净利润", type: "bar", data: charts.financials.netIncome },
      { name: "经营现金流", type: "line", data: charts.financials.operatingCashFlow },
    ],
  };
}

function marginOption(charts: ChartBundle): Record<string, unknown> | null {
  if (charts.margins.periods.length === 0) return null;
  const percent = (values: Array<number | null>) => values.map((value) => value === null ? null : Number((value * 100).toFixed(2)));
  return {
    tooltip: { trigger: "axis" },
    legend: { data: ["毛利率", "净利率", "ROE", "资产负债率"] },
    xAxis: { type: "category", data: charts.margins.periods },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      { name: "毛利率", type: "line", data: percent(charts.margins.gross) },
      { name: "净利率", type: "line", data: percent(charts.margins.net) },
      { name: "ROE", type: "line", data: percent(charts.margins.roe) },
      { name: "资产负债率", type: "line", data: percent(charts.margins.debt) },
    ],
  };
}

function priceOption(charts: ChartBundle): Record<string, unknown> | null {
  if (charts.prices.dates.length === 0) return null;
  return {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: charts.prices.dates },
    yAxis: { type: "value", scale: true },
    series: [{ name: "前复权收盘价", type: "line", showSymbol: false, data: charts.prices.closes, areaStyle: { opacity: 0.08 } }],
  };
}

function drawdownOption(charts: ChartBundle): Record<string, unknown> | null {
  if (charts.drawdowns.labels.length === 0) return null;
  return {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: charts.drawdowns.labels },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => `${(value * 100).toFixed(0)}%` } },
    series: [{ name: "最大回撤", type: "bar", data: charts.drawdowns.rates }],
  };
}

function capitalOption(charts: ChartBundle): Record<string, unknown> | null {
  if (!charts.capital) return null;
  return {
    tooltip: { trigger: "item" },
    series: [{
      type: "pie",
      radius: ["45%", "70%"],
      data: [
        { name: "总负债", value: charts.capital.liabilities },
        { name: "归母权益", value: charts.capital.equity },
      ],
    }],
  };
}

function holderOption(charts: ChartBundle): Record<string, unknown> | null {
  if (charts.holders.length === 0) return null;
  return {
    tooltip: { trigger: "item" },
    series: [{ type: "pie", roseType: "radius", data: charts.holders.map((item) => ({ name: item.name, value: item.ratioPercent })) }],
  };
}

function sentimentOption(charts: ChartBundle): Record<string, unknown> | null {
  const total = charts.sentiment.positive + charts.sentiment.negative + charts.sentiment.neutral;
  if (total === 0) return null;
  return {
    tooltip: { trigger: "item" },
    series: [{
      type: "pie",
      data: [
        { name: "正面", value: charts.sentiment.positive },
        { name: "负面", value: charts.sentiment.negative },
        { name: "中性", value: charts.sentiment.neutral },
      ],
    }],
  };
}

function riskOption(charts: ChartBundle): Record<string, unknown> | null {
  if (charts.risks.length === 0) return null;
  return {
    tooltip: { trigger: "item" },
    xAxis: { name: "证据强度", min: 0, max: 3 },
    yAxis: { name: "影响", min: 0, max: 3 },
    series: [{ type: "scatter", data: charts.risks.map((item) => ({ name: item.name, value: [item.probability, item.impact] })) }],
  };
}
