import { Hono } from "hono";
import { auth, requireSeller } from "./auth";
import { catalog } from "./routes/catalog";
import { endpoints } from "./routes/endpoints";
import { paid } from "./routes/paid";
import { stats } from "./routes/stats";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({
    service: "x402-gateway",
    network: c.env.NETWORK,
    catalog: "/catalog",
    paid: "/x/:id",
  }),
);

app.route("/catalog", catalog);
app.route("/x", paid);

app.route("/api/auth", auth);
app.use("/api/*", async (c, next) => (c.req.path.startsWith("/api/auth/") ? next() : requireSeller(c, next)));
app.route("/api/endpoints", endpoints);
app.route("/api", stats);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
