import { redirect } from "next/navigation";
import { ErrorState } from "../components/Overview";
import { RepoList } from "../components/RepoList";
import { apiClientFromEnv } from "../lib/api";
import { describeError } from "../lib/errors";
import { decideHome } from "../lib/home";
import type { RawSearchParams } from "../lib/overview";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = (await searchParams).list;
  const showAll = (Array.isArray(raw) ? raw[0] : raw) === "1";

  let result: Awaited<ReturnType<typeof decideHome>>;
  try {
    result = await decideHome(apiClientFromEnv(), showAll);
  } catch (error) {
    // apiClientFromEnv() throws before decideHome can wrap anything when the environment is not configured.
    return <ErrorState {...describeError(error)} />;
  }

  if (result.kind === "redirect") redirect(`/repos/${result.repoId}`);
  if (result.kind === "error") return <ErrorState {...result.error} />;
  return <RepoList repos={result.repos} total={result.total} />;
}
