export const REQUEST_AUTH_CONTEXT = Symbol("pmm-career-mcp.request-auth-context");

export type RequestAuthContext = Readonly<{
  subject: string;
  accessToken: string;
}>;

export type AuthenticatedLocals = {
  [REQUEST_AUTH_CONTEXT]?: RequestAuthContext;
};
