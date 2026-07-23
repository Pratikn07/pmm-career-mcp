import type { FetchedPage } from "../../src/research/fetch-page.js";
import type { YcSourcePage } from "../../src/research/yc-provider.js";
import type { RequestAuthContext } from "../../src/auth/request-context.js";

export const E2E_NOW = "2026-07-17T12:00:00.000Z";
export const E2E_SUBJECT = "123e4567-e89b-42d3-a456-426614174000";
export const E2E_AUTH_CONTEXT: RequestAuthContext = Object.freeze({
  subject: E2E_SUBJECT,
  accessToken: "private-request-token"
});

export const YC_DIRECTORY_FIXTURE: YcSourcePage = {
  url: "https://www.ycombinator.com/companies",
  checkedAt: E2E_NOW,
  html: `<!doctype html><html><head><title>YC companies</title></head><body>
    <main data-yc-company-directory>
      <article data-yc-company-id="acme-yc">
        <a class="company-name" href="/companies/acme">Acme</a>
        <span data-company-batch>W26</span>
        <span data-company-status>Active</span>
        <span data-company-location>San Francisco</span>
        <span data-company-industry>Developer tools</span>
        <span data-company-hiring>Hiring</span>
        <p class="company-description">Developer tools for teams.</p>
        <a data-company-website href="https://acme.example/">Website</a>
      </article>
    </main>
  </body></html>`
};

export const COMPANY_HOME_FIXTURE: FetchedPage = {
  url: "https://acme.example/",
  title: "Acme",
  text: "Jordan Lee VP Marketing Careers",
  checkedAt: E2E_NOW,
  contentType: "text/html",
  untrusted: true,
  html: `<!doctype html><html><head><title>Acme</title></head><body>
    <article data-team-member><h2 data-person-name>Jordan Lee</h2><p data-person-role>VP Marketing</p></article>
    <a href="/careers">Careers</a>
  </body></html>`
};

/** This fixture is an allowlist: unexpected URLs prove an accidental network path. */
export function mockedCompanyPage(url: string): FetchedPage {
  if (url === COMPANY_HOME_FIXTURE.url) return COMPANY_HOME_FIXTURE;
  throw new Error(`Unexpected mocked public endpoint: ${url}`);
}
