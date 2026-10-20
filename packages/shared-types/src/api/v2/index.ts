/**
 * API v2 schemas (/api/v2, docs/openapi.v2.json). The ones that name a CI run, CI source or host are defined here; the
 * rest live one level up and are re-exported, so that `v2.*` is the whole contract.
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
