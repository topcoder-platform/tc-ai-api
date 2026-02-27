export const M2mConfig = {
  auth0: {
    url: process.env.M2M_AUTH_URL ?? 'https://topcoder-dev.auth0.com/oauth/token',
    domain: process.env.M2M_AUTH_DOMAIN ?? 'topcoder-dev.auth0.com',
    audience: process.env.M2M_AUTH_AUDIENCE ?? 'https://m2m.topcoder-dev.com/',
    proxyUrl: process.env.M2M_AUTH_PROXY_SERVER_URL ?? 'https://auth0proxy.topcoder-dev.com/token',
    clientId: process.env.M2M_AUTH_CLIENT_ID,
    clientSecret: process.env.M2M_AUTH_CLIENT_SECRET,
  },
};
