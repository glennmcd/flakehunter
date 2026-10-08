import { errorResponseSchema } from "@flakehunter/shared-types";

/** Documented error responses for a route, in the form the `response` schema map takes. */
export function errorResponses<const T extends readonly (400 | 401 | 404 | 413 | 422 | 429)[]>(...statuses: T) {
  return Object.fromEntries(statuses.map((status) => [status, errorResponseSchema])) as {
    [S in T[number]]: typeof errorResponseSchema;
  };
}
