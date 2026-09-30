import path from "node:path";
import { fileURLToPath } from "node:url";
import autoload from "@fastify/autoload";
import Fastify from "fastify";
import authPlugin from "./plugins/auth.js";
import dbPlugin from "./plugins/db.js";
import githubPlugin from "./plugins/github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fastify = Fastify({ logger: true });

await fastify.register(dbPlugin);
await fastify.register(authPlugin);
await fastify.register(githubPlugin);
await fastify.register(autoload, {
  dir: path.join(__dirname, "routes"),
});

const port = Number(process.env.PORT ?? 3000);
await fastify.listen({ port, host: "0.0.0.0" });
