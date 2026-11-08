import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3000);
const app = await createApp({ enableVite: process.env.NODE_ENV !== "production" });
app.listen(port, "127.0.0.1", () => {
  console.log(`基本面研究台已在 http://127.0.0.1:${port} 启动`);
});
