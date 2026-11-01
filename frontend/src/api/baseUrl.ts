// Where the browser sends API requests (ConnectRPC calls and the AI chat REST call).
//
// VITE_API_URL controls it at build time:
//   - a full URL (e.g. http://localhost:8082)  -> use it as is
//   - "same-origin"                            -> use whatever origin served the page.
//     The Cloudflare deployment serves the site and the API from one Worker
//     hostname, so there is nothing to hard-code and no CORS to configure.
//   - unset                                    -> local backend default
const configured = import.meta.env.VITE_API_URL as string | undefined;

export const API_BASE_URL: string =
  configured === "same-origin"
    ? window.location.origin
    : configured || "http://localhost:8082";
