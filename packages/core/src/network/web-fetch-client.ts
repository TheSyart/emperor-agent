import type { PublicHttpGetResponse, PublicHttpRequest } from './public-http'

/** Host-injectable public-HTTP GET client used by the `web_fetch` capability. */
export interface WebFetchClient {
  get(request: PublicHttpRequest): Promise<PublicHttpGetResponse>
}
