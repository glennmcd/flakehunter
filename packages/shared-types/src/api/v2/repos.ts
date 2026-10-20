import { z } from "zod";
import { pageSchema } from "../common";
import { repoItemSchema as v1RepoItemSchema } from "../repos";
import { repoHostSchema } from "./common";

export const repoItemSchema = v1RepoItemSchema.extend({ host: repoHostSchema });
export type RepoItem = z.infer<typeof repoItemSchema>;

export const reposResponseSchema = z.object({ data: z.array(repoItemSchema), page: pageSchema });
export type ReposResponse = z.infer<typeof reposResponseSchema>;
