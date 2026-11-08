export function Report({ markdown }: { markdown: string }) {
  const blocks = markdown.split("\n");
  const nodes: Array<{ kind: "h1" | "h2" | "h3" | "p" | "table"; text: string }> = [];
  let table: string[] = [];
  const flush = () => {
    if (table.length === 0) return;
    nodes.push({ kind: "table", text: table.join("\n") });
    table = [];
  };
  for (const line of blocks) {
    if (line.startsWith("|")) {
      table.push(line);
      continue;
    }
    flush();
    if (line.startsWith("### ")) nodes.push({ kind: "h3", text: line.slice(4) });
    else if (line.startsWith("## ")) nodes.push({ kind: "h2", text: line.slice(3) });
    else if (line.startsWith("# ")) nodes.push({ kind: "h1", text: line.slice(2) });
    else nodes.push({ kind: "p", text: line });
  }
  flush();
  return (
    <article className="report">
      {nodes.map((node, index) => {
        if (node.kind === "h1") return <h2 key={index}>{node.text}</h2>;
        if (node.kind === "h2") return <h3 key={index}>{node.text}</h3>;
        if (node.kind === "h3") return <h4 key={index}>{node.text}</h4>;
        if (node.kind === "table") return <pre key={index}>{node.text}</pre>;
        return <p key={index}>{node.text || "\u00a0"}</p>;
      })}
    </article>
  );
}
