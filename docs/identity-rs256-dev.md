# Identity RS256 preparation for dev

This PR pins tc-core-library-js 4.0.0-rc.4 at commit `c7c8fab502b7152dd06b1ce46cdb703e0e13b357`. It requires explicit issuer policies and retains verified-email and identity-denylist enforcement.

The public settings are staged in dev Parameter Store under `/config/identity-rs256-dev-staged/`; running services do not reference that namespace. The checked-in JSON is a reviewed configuration proposal, not an automatically applied deployment change.

Before merging/deploying, coordinate with Identity and all token consumers. Set `JWT_ISSUER_POLICIES` to the JSON in `deploy/dev-jwt-issuer-policies.json`, retaining the service's machine audience and authorization checks. Merely adding `AUTH_SECRET` no longer enables HMAC trust. If a transition needs HS256, configure only that exact issuer with a finite UTC retirement deadline, then replace it with RS256 at the coordinated cutover. Never accept both algorithms for one issuer.

An explicit public policy replaces the two fixed Auth0 providers while retaining machine-audience checks and resource ownership. Supply an RSA-only policy: this service intentionally receives no HMAC signing secret. Normalized Identity user IDs and Auth0 namespaced IDs map to the same resource ID.

Publish the Identity public key first; then test fresh login, expiry/refresh, logout, cross-app access, human authorization, machine authorization, wrong-audience rejection and legacy-HMAC rejection. Remove AUTH_SECRET only from public-key-only API verifiers; keep separate keys for application proofs, cursors, and independent local-login tokens. Existing browser sessions continue to use Auth0; do not put Identity-issued tokens into the Accounts connector cookie without implementing an Identity-aware refresh flow.

Production is not changed. This dev policy intentionally does not trust the production Topcoder issuer. Do not merge this into production without its separately reviewed environment policy and key.
