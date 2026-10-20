import { z } from "zod";
import { CI_SOURCES, REPO_HOSTS } from "../../domain";

/** The CI system that ran a workflow run. Lists exactly the values the database accepts. */
export const ciSourceSchema = z.enum(CI_SOURCES);

/** Where a repository's code lives. Lists exactly the values the database accepts. */
export const repoHostSchema = z.enum(REPO_HOSTS);
