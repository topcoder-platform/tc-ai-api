import { resourceIdMiddleware, chatResourceIdMiddleware } from './resourceIdMiddleware';
import { toolProvidersMiddleware } from './toolProvidersMiddleware';

export * from './resourceIdMiddleware';
export const middlewareConfig: any[] = [];

// Only when auth is enabled
if (process.env.DISABLE_AUTH !== 'true') {
    middlewareConfig.push(resourceIdMiddleware, chatResourceIdMiddleware);
}

middlewareConfig.push(toolProvidersMiddleware);
