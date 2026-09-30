import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import autoload from "@fastify/autoload";
import dbPlugin from "./plugins/db.js";
import authPlugin from "./plugins/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fastify = Fastify({ logger: true });

await fastify.register(dbPlugin);
await fastify.register(authPlugin);
await fastify.register(autoload, {
  dir: path.join(__dirname, "routes"),
});

const port = Number(process.env.PORT ?? 3000);
await fastify.listen({ port, host: "0.0.0.0" });
