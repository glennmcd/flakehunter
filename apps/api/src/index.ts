import { buildApp } from "./app.js";

const fastify = await buildApp();

const port = Number(process.env.PORT ?? 3000);
await fastify.listen({ port, host: "0.0.0.0" });
