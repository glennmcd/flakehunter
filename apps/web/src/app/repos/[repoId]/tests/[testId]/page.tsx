import { notFound } from "next/navigation";
import { ErrorState } from "../../../../../components/Overview";
import { TestDetail } from "../../../../../components/TestDetail";
import { apiClientFromEnv } from "../../../../../lib/api";
import { describeError, isNotFound } from "../../../../../lib/errors";
import { parseHistoryParams } from "../../../../../lib/history";
import { loadHistory } from "../../../../../lib/historyData";
import type { RawSearchParams } from "../../../../../lib/overview";
import { parseId } from "../../../../../lib/routeParams";

export const dynamic = "force-dynamic";

export default async function TestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ repoId: string; testId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const route = await params;
  const repoId = parseId(route.repoId);
  const testId = parseId(route.testId);
  if (repoId === undefined || testId === undefined) notFound();
  const historyParams = parseHistoryParams(await searchParams);

  try {
    const data = await loadHistory(apiClientFromEnv(), repoId, testId, historyParams);
    return <TestDetail repoId={repoId} params={historyParams} {...data} />;
  } catch (error) {
    if (isNotFound(error)) notFound();
    return <ErrorState {...describeError(error)} />;
  }
}
