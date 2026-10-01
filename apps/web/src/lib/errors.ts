import { ApiClientError } from "./api";
import { EnvError } from "./env";

export interface ErrorView {
  title: string;
  message: string;
  requestId?: string;
}

/**
 * What to show for a failed page load. Messages are fixed text chosen by error code, never the raw error, so a
 * misconfiguration cannot leak a URL, token or stack trace into the page.
 */
export function describeError(error: unknown): ErrorView {
  if (error instanceof EnvError) {
    return {
      title: "The dashboard is not configured",
      message: "The server is missing required settings (API_BASE_URL or API_TOKEN). Check the deployment environment.",
    };
  }
  if (error instanceof ApiClientError) {
    const requestId = error.requestId;
    switch (error.code) {
      case "network":
        return { title: "Cannot reach the API", message: "The API did not respond. Try again in a moment.", requestId };
      case "unauthorized":
        return {
          title: "The API rejected the dashboard's token",
          message: "The server's API_TOKEN does not match the API. Check the deployment environment.",
          requestId,
        };
      case "invalid_response":
        return {
          title: "Unexpected response from the API",
          message: "The API returned data in a shape this dashboard does not understand.",
          requestId,
        };
      default:
        return {
          title: "The API reported an error",
          message: "Something went wrong while loading this page.",
          requestId,
        };
    }
  }
  return { title: "Something went wrong", message: "An unexpected error occurred while loading this page." };
}

/** True for the API's 404, which pages turn into Next's not-found page. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "not_found";
}
