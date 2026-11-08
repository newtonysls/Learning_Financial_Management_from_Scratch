export function MetricCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="metric">
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
