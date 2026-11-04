# OIDC deployment migration

This change replaces the Auth0 credential broker and SSM-to-shell deployment path with [tc-deploy-scripts v2.0.5](https://github.com/topcoder-platform/tc-deploy-scripts/releases/tag/v2.0.5), fetched by tag and verified against commit `bff574ab5c0b46773e25d2af1eff76675fba2ba5`. Build and deployment run in separate jobs. The deployer cannot read Parameter Store, Secrets Manager or decrypt KMS data, including through another assumed role. ECS continues resolving the existing runtime secret references using the execution role.

## Production target

The read-only inventory on 2026-11-03 verified account `409275337247`, cluster `tc-ai`, service `tc-ai-api`, family `tc-ai-api`, and container `tc-ai-api`. `prod.json` preserves the observed task/execution roles and names the proposed service-specific deployment role. [prod-baseline.json](https://github.com/topcoder-platform/v6-services-iac/blob/main/services/tc-ai-api/deploy/prod-baseline.json) records references only; it contains no parameter values. Do not recreate the service or replace its complete task definition from this baseline.

## Installed infrastructure and production cutover

The dev deployment role/boundary, restricted empty CircleCI context, and immutable ECR tags are installed. Existing enhanced scanning is preserved. The production OIDC provider, deployment role/boundary and restricted context are also installed; production runtime and ECR changes remain gated on dev validation. Installation evidence and remaining service-specific steps are private in [PROVISIONING.txt](https://github.com/topcoder-platform/v6-services-iac/blob/main/services/tc-ai-api/deploy/PROVISIONING.txt). Deploy roles have explicit secret-store and KMS-decryption denies. Runtime values are retrieved only by ECS using the execution role.

At production cutover, stop legacy publishers, enable unconditional tag immutability, adopt missing task health checks with the reviewed image, and use the approval-gated `master` workflow. Preserve capacity, roles, secret references and rollback. Do not run production before dev validation.

## Development acceptance

This PR targets `develop`. Administrator-installed dev prerequisites are recorded in the private IaC repository. The reviewed task health check was submitted only after confirming the existing image serves the identical healthy load-balancer endpoint.

- Dev infrastructure prerequisites are installed; merge to run the application deployment, then validate functionality.

Run the shared offline suite, validate the CircleCI config and IAM policies, and test a dev release plus an unhealthy-image rollback. Verify CloudTrail contains no SSM/Secrets Manager calls from the deployment principal. Remove its old broker grants only after migration. Check the runtime secret references and roles stayed unchanged. Production requires the manual approval job and a passing digest/scan/health verification.

The pinned executor is `cimg/aws@sha256:4cf3768db00ddf9bc439b8c84e8a60c11a14edf81c8baf76f74132144f8340d5`. Python/AWS CLI/Buildx/Git compatibility was tested with the shared offline suite. No package installation or service build runs in the deployment job. The Dockerfile retains the existing in-image quality gates. This PR does not deploy, change IAM, rotate credentials, or claim a successful live rollout.

## Infrastructure source

IAM templates and detailed AWS baselines are maintained in the private [v6-services-iac service directory](https://github.com/topcoder-platform/v6-services-iac/tree/main/services/tc-ai-api). Provision infrastructure separately with an administrator identity; application CI does not fetch that repository or install IAM. Required application manifests and health-check proposals remain here.

## Dev branch refresh

This PR targets `develop` and preserves its current application/dependency fixes. The shared suite is v2.0.5 (82 offline tests); service-specific adapters and their tests remain part of review. Use the current readiness record above for the remaining merge/deployment gates. Updating these files does not provision AWS or CircleCI resources.

Source checkout uses the public HTTPS repository and verifies the exact CircleCI commit, avoiding dependency on failing SSH checkout keys. No GitHub token is added to build or deployment contexts.
