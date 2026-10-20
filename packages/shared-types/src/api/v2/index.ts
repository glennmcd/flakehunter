/**
 * API v2 schemas (/api/v2, docs/openapi.v2.json). The ones v2 changes are defined here; the rest are v1's, re-exported
 * so that `v2.*` is the whole contract.
 */
export {
  type ApiErrorCode,
  type ApiErrorResponse,
  errorCodeSchema,
  errorResponseSchema,
  idParamSchema,
  pageSchema,
  paginationQuerySchema,
  testStatusSchema,
} from "../common";
export { reportCountsSchema } from "../reports";
export {
  type RepoSummaryResponse,
  repoSummaryQuerySchema,
  repoSummaryResponseSchema,
  reposQuerySchema,
} from "../repos";
export {
  type FlakyTestItem,
  flakyTestItemSchema,
  flakyTestsResponseSchema,
  testHistoryQuerySchema,
} from "../tests";
export * from "./common";
export * from "./reports";
export * from "./repos";
export * from "./tests";
