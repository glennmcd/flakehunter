import { z } from "zod";
import { pageSchema } from "../common";
import { repoHostSchema } from "./common";

export const repoItemSchema = z.object({
  id: z.number().int(),
  fullName: z.string(),
  owner: z.string(),
  name: z.string(),
  host: repoHostSchema,
});
export type RepoItem = z.infer<typeof repoItemSchema>;

export const reposResponseSchema = z.object({ data: z.array(repoItemSchema), page: pageSchema });
export type ReposResponse = z.infer<typeof reposResponseSchema>;
