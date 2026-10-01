import { notFound } from "next/navigation";
import { ErrorState, Overview } from "../../../components/Overview";
import { apiClientFromEnv } from "../../../lib/api";
import { describeError, isNotFound } from "../../../lib/errors";
import { parseOverviewParams, type RawSearchParams } from "../../../lib/overview";
import { loadOverview } from "../../../lib/overviewData";
import { parseId } from "../../../lib/routeParams";

export const dynamic = "force-dynamic";

export default async function RepoOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ repoId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const repoId = parseId((await params).repoId);
  if (repoId === undefined) notFound();
  const overviewParams = parseOverviewParams(await searchParams);

  try {
    const data = await loadOverview(apiClientFromEnv(), repoId, overviewParams);
    return <Overview repoId={repoId} params={overviewParams} {...data} />;
  } catch (error) {
    if (isNotFound(error)) notFound();
    return <ErrorState {...describeError(error)} />;
  }
}
